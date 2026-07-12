// verify-key-persist-fix.mjs — verifies the Settings API-key-disappears-on-
// click bug is fixed: save a (fake, non-credential) key, reload the
// Settings page fresh, click into the field, confirm the masked value is
// still there (not cleared), and confirm the underlying chrome.storage
// value is genuinely unaffected. Also confirms clicking Save on an
// untouched field no longer risks wiping the stored key. Real Brave.

import { chromium } from '@playwright/test';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.join(__dirname, '.output', 'chrome-mv3');
const USER_DATA_DIR = path.join(__dirname, '.tmp-brave-key-persist-profile');
const VERIFICATION_DIR = path.join(__dirname, 'verification');
const BRAVE_PATH = 'C:/Users/Asus/AppData/Local/BraveSoftware/Brave-Browser/Application/brave.exe';
const FAKE_KEY = 'AIzaSyFAKE_PERSIST_TEST_KEY_NOT_REAL_00000';

async function main() {
  console.log('=== Building extension ===');
  execSync('npm run build', { stdio: 'inherit', cwd: __dirname });
  fs.mkdirSync(VERIFICATION_DIR, { recursive: true });
  fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    executablePath: BRAVE_PATH,
    headless: false,
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
  });

  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
  const extensionId = sw ? new URL(sw.url()).hostname : null;

  try {
    // --- Step 1: paste + save a key ---
    const page1 = await context.newPage();
    await page1.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: 'domcontentloaded' });
    await page1.waitForTimeout(600);

    const input1 = page1.locator('input[placeholder="Paste API key"]').first();
    await input1.click();
    await input1.fill(FAKE_KEY);
    await page1.locator('button:has-text("Save")').click();
    await page1.waitForTimeout(500);

    const afterSave = await page1.evaluate(() => document.querySelector('input[placeholder="Paste API key"]').value);
    console.log('Field value right after Save:', afterSave);
    await page1.screenshot({ path: path.join(VERIFICATION_DIR, 'kp-after-save.png') });

    // Confirm the REAL stored value via chrome.storage directly.
    const storedAfterSave = await page1.evaluate(async () => {
      const result = await chrome.storage.local.get('gradelens.settings');
      return result['gradelens.settings']?.geminiKey;
    });
    console.log('chrome.storage geminiKey after save:', storedAfterSave);
    await page1.close();

    // --- Step 2: fresh reload of the Settings page (new page = fresh mount) ---
    const page2 = await context.newPage();
    await page2.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: 'domcontentloaded' });
    await page2.waitForTimeout(600);

    const input2 = page2.locator('input[placeholder="Paste API key"]').first();
    const maskedOnLoad = await input2.inputValue();
    console.log('\nMasked value on fresh page load:', maskedOnLoad);
    await page2.screenshot({ path: path.join(VERIFICATION_DIR, 'kp-fresh-load.png') });

    // --- Step 3: click the field (the actual bug trigger) ---
    await input2.click();
    await page2.waitForTimeout(200);
    const afterClick = await input2.inputValue();
    console.log('Value immediately after clicking the field:', afterClick);
    await page2.screenshot({ path: path.join(VERIFICATION_DIR, 'kp-after-click.png') });

    // --- Step 4: click elsewhere (blur) without typing, confirm still intact ---
    await page2.locator('.row-label').first().click();
    await page2.waitForTimeout(200);
    const afterBlur = await input2.inputValue();
    console.log('Value after clicking away (blur) without typing:', afterBlur);

    // --- Step 5: confirm storage is STILL correct (guards against the
    // click -> empty -> accidental-Save data-loss path too) ---
    const storedAfterClicking = await page2.evaluate(async () => {
      const result = await chrome.storage.local.get('gradelens.settings');
      return result['gradelens.settings']?.geminiKey;
    });
    console.log('chrome.storage geminiKey after clicking around:', storedAfterClicking);

    // --- Step 6: confirm select-all actually happened (so typing would
    // replace, not insert into, the masked text) ---
    await input2.click();
    const selectionInfo = await page2.evaluate(() => {
      const el = document.querySelector('input[placeholder="Paste API key"]');
      return { selectionStart: el.selectionStart, selectionEnd: el.selectionEnd, valueLength: el.value.length };
    });
    console.log('\nSelection on focus:', selectionInfo, '(expect selectionStart=0, selectionEnd=valueLength = full select)');

    await page2.close();

    const pass = maskedOnLoad.includes('*')
      && afterClick === maskedOnLoad
      && afterBlur === maskedOnLoad
      && storedAfterSave === FAKE_KEY
      && storedAfterClicking === FAKE_KEY
      && selectionInfo.selectionStart === 0
      && selectionInfo.selectionEnd === selectionInfo.valueLength;

    console.log('\n=== RESULT ===');
    console.log(pass ? 'PASS: masked key survives click/blur untouched, storage never wiped, click selects-all for easy replace-typing.' : 'FAIL — see values above.');
  } finally {
    await context.close();
  }
}

main().catch((err) => {
  console.error('CRASHED:', err);
  process.exitCode = 1;
});
