// verify-dev-tools.mjs — end-to-end verification that entrypoints/dev-tools
// still works after all the recent refactors: reset trial counter, force
// Pro override, both actually taking effect in the real TrustPanel, AND
// confirms the page is physically absent from a real production build.
// Real Brave.

import { chromium } from '@playwright/test';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, '.output', 'chrome-mv3');
const USER_DATA_DIR = path.join(__dirname, '.tmp-brave-dev-tools-profile');
const VERIFICATION_DIR = path.join(__dirname, 'verification');
const BRAVE_PATH = 'C:/Users/Asus/AppData/Local/BraveSoftware/Brave-Browser/Application/brave.exe';
const PRODUCT_URL = process.env.TL_VERIFY_URL || 'https://www.amazon.in/dp/B08RQJKF6D';

async function clickThroughInterstitial(page) {
  const continueBtn = page.locator('button:has-text("Continue shopping"), input[value="Continue shopping"]');
  if ((await continueBtn.count()) > 0) {
    await continueBtn.first().click();
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }
}

async function main() {
  console.log('=== PART 1: production build must NOT contain dev-tools ===');
  fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
  execSync('npm run build', { stdio: 'inherit', cwd: __dirname }); // real `wxt build`, real NODE_ENV=production
  const prodFiles = fs.readdirSync(OUTPUT_DIR, { recursive: true });
  const devToolsInProd = prodFiles.filter((f) => f.toString().toLowerCase().includes('dev-tools'));
  console.log('dev-tools-related files in production build:', devToolsInProd);
  console.log(devToolsInProd.length === 0 ? 'PASS: absent from production build.' : 'FAIL: dev-tools leaked into production build!');

  console.log('\n=== PART 2: dev build — functional end-to-end test ===');
  fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
  execSync('npx wxt build', { stdio: 'inherit', cwd: __dirname, env: { ...process.env, NODE_ENV: 'development' } });

  fs.mkdirSync(VERIFICATION_DIR, { recursive: true });
  fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    executablePath: BRAVE_PATH,
    headless: false,
    args: [`--disable-extensions-except=${OUTPUT_DIR}`, `--load-extension=${OUTPUT_DIR}`],
  });

  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
  const extensionId = sw ? new URL(sw.url()).hostname : null;
  console.log('Extension ID:', extensionId);

  try {
    // --- Simulate having hit the free-trial limit ---
    const setupPage = await context.newPage();
    await setupPage.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: 'domcontentloaded' });
    await setupPage.evaluate(() => chrome.storage.local.set({ gradelens_ai_uses: 5 }));
    console.log('\nSimulated: gradelens_ai_uses set to 5 (0 of 5 remaining).');
    await setupPage.close();

    // --- Open dev-tools.html directly ---
    const devPage = await context.newPage();
    const devToolsUrl = `chrome-extension://${extensionId}/dev-tools.html`;
    console.log('Opening:', devToolsUrl);
    await devPage.goto(devToolsUrl, { waitUntil: 'domcontentloaded' });
    await devPage.waitForTimeout(500);

    const initialText = await devPage.evaluate(() => document.querySelector('.trial-meter span')?.textContent);
    console.log('Trial meter before reset:', initialText);
    await devPage.screenshot({ path: path.join(VERIFICATION_DIR, 'devtools-before-reset.png') });

    // --- Click Reset counter ---
    await devPage.locator('button:has-text("Reset counter")').click();
    await devPage.waitForTimeout(400);
    const afterResetText = await devPage.evaluate(() => document.querySelector('.trial-meter span')?.textContent);
    console.log('Trial meter after reset:', afterResetText);
    const storedUsageAfterReset = await devPage.evaluate(() => chrome.storage.local.get('gradelens_ai_uses'));
    console.log('chrome.storage gradelens_ai_uses after reset:', storedUsageAfterReset);
    await devPage.screenshot({ path: path.join(VERIFICATION_DIR, 'devtools-after-reset.png') });

    // --- Toggle Local dev Pro ---
    const proToggleBefore = await devPage.evaluate(() => document.querySelector('.toggle-row input').checked);
    console.log('\nLocal dev Pro toggle before click:', proToggleBefore);
    await devPage.locator('.toggle-row .switch').click();
    await devPage.waitForTimeout(400);
    const proToggleAfter = await devPage.evaluate(() => document.querySelector('.toggle-row input').checked);
    console.log('Local dev Pro toggle after click:', proToggleAfter);
    const storedSettingsAfterToggle = await devPage.evaluate(async () => {
      const result = await chrome.storage.local.get('gradelens.settings');
      return result['gradelens.settings'];
    });
    console.log('chrome.storage gradelens.settings after toggle:', JSON.stringify(storedSettingsAfterToggle));
    await devPage.screenshot({ path: path.join(VERIFICATION_DIR, 'devtools-pro-on.png') });
    await devPage.close();

    // --- Confirm the REAL TrustPanel picks up the Pro override on a live Amazon page ---
    const amazonPage = await context.newPage();
    await amazonPage.goto(PRODUCT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await clickThroughInterstitial(amazonPage);
    const panel = amazonPage.locator('#gradelens-root .gradelens-panel');
    await panel.waitFor({ state: 'visible', timeout: 30000 });
    await amazonPage.waitForTimeout(2000); // let the async isPro-loading effect settle
    const planBadge = await amazonPage.evaluate(() => document.querySelector('.gradelens-plan-badge')?.textContent);
    const planDataAttr = await amazonPage.evaluate(() => document.querySelector('.gradelens-plan-badge')?.getAttribute('data-plan'));
    console.log('\nTrustPanel plan badge on live Amazon page:', planBadge, '(data-plan=' + planDataAttr + ')');
    await panel.scrollIntoViewIfNeeded();
    await panel.screenshot({ path: path.join(VERIFICATION_DIR, 'devtools-panel-shows-pro.png') });
    await amazonPage.close();

    console.log('\n=== RESULT ===');
    const pass = devToolsInProd.length === 0
      && initialText?.startsWith('0 of 5')
      && afterResetText?.startsWith('5 of 5')
      && storedUsageAfterReset.gradelens_ai_uses === 0
      && proToggleAfter === true
      && storedSettingsAfterToggle?.devProOverride === true
      && planDataAttr === 'pro';
    console.log(pass ? 'PASS: dev tools fully functional, production build clean.' : 'FAIL — see values above.');
  } finally {
    await context.close();
  }
}

main().catch((err) => {
  console.error('CRASHED:', err);
  process.exitCode = 1;
});
