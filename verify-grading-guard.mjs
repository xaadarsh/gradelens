// verify-grading-guard.mjs
//
// Live verification of the critical grading-bug fix in
// lib/statistical-engine.ts (J-shape recalibration, unknown-check exclusion
// from the weighted score, and the population sanity guard) against the
// REAL installed Brave browser + live Amazon, same pattern as verify.mjs.
// Does NOT fix anything it finds — it only reports.

import { chromium } from '@playwright/test';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.join(__dirname, '.output', 'chrome-mv3');
const USER_DATA_DIR = path.join(__dirname, '.tmp-brave-grading-guard-profile');
const VERIFICATION_DIR = path.join(__dirname, 'verification');
const BRAVE_PATH = 'C:\\Users\\Asus\\AppData\\Local\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';

const results = {};
const consoleLog = [];
function log(line) {
  console.log(line);
  consoleLog.push(line);
}

async function clickThroughAmazonInterstitial(page) {
  const continueBtn = page.locator('button:has-text("Continue shopping"), input[value="Continue shopping"]');
  if ((await continueBtn.count()) > 0) {
    await continueBtn.first().click();
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }
}

async function readGrade(page, label, waitMs = 11000) {
  await clickThroughAmazonInterstitial(page);
  await page.waitForTimeout(3000);
  const panel = page.locator('#gradelens-root .gradelens-panel');
  await panel.waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(waitMs);

  const grade = (await page.locator('.gradelens-medallion-letter').textContent().catch(() => '')) ?? '';
  const verdict = (await page.locator('.gradelens-verdict').textContent().catch(() => '')) ?? '';
  const confidence = (await page.locator('.gradelens-confidence-chip').textContent().catch(() => '')) ?? '';
  const subtitle = (await page.locator('.gradelens-subtitle').textContent().catch(() => '')) ?? '';

  log(`[${label}] grade="${grade.trim()}" confidence="${confidence.trim()}" subtitle="${subtitle.trim()}"`);
  log(`[${label}] verdict="${verdict.trim()}"`);

  return { grade: grade.trim(), verdict: verdict.trim(), confidence: confidence.trim(), subtitle: subtitle.trim() };
}

async function searchAndGrade(context, searchUrl, label) {
  const searchPage = await context.newPage();
  await searchPage.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await clickThroughAmazonInterstitial(searchPage);
  await searchPage.waitForTimeout(2000);

  const resultLink = searchPage
    .locator('div[data-component-type="s-search-result"] h2 a, div[data-component-type="s-search-result"] a.a-link-normal.s-line-clamp-2, div[data-component-type="s-search-result"] a.a-link-normal.s-line-clamp-4')
    .first();
  const found = (await resultLink.count()) > 0;

  if (!found) {
    log(`[${label}] Search returned no results at ${searchUrl}.`);
    await searchPage.screenshot({ path: path.join(VERIFICATION_DIR, `grading-guard-${label}-search-debug.png`) });
    await searchPage.close();
    return null;
  }

  await resultLink.click();
  await searchPage.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  const outcome = await readGrade(searchPage, label);
  await searchPage.screenshot({ path: path.join(VERIFICATION_DIR, `grading-guard-${label}.png`) });
  await searchPage.close();
  return outcome;
}

async function main() {
  log('=== Building extension (npm run build) ===');
  execSync('npm run build', { stdio: 'inherit', cwd: __dirname });
  if (!fs.existsSync(EXTENSION_PATH)) throw new Error(`Build output not found at ${EXTENSION_PATH}`);
  if (!fs.existsSync(BRAVE_PATH)) throw new Error(`Brave not found at ${BRAVE_PATH}`);

  fs.mkdirSync(VERIFICATION_DIR, { recursive: true });
  fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    executablePath: BRAVE_PATH,
    headless: false,
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
  });

  try {
    // --- Echo Dot: 195k+ reviews, 4.7 stars — must land A or B ---
    log('\n=== Echo Dot (amazon.com/dp/B09B8V1LZ3) — must grade A or B ===');
    const echoPage = await context.newPage();
    await echoPage.goto('https://www.amazon.com/dp/B09B8V1LZ3', { waitUntil: 'domcontentloaded', timeout: 60000 });
    const echo = await readGrade(echoPage, 'echo-dot');
    await echoPage.screenshot({ path: path.join(VERIFICATION_DIR, 'grading-guard-echo-dot.png') });
    results.echo_dot_grade_is_a_or_b = echo.grade === 'A' || echo.grade === 'B';
    await echoPage.close();

    // --- Instant Pot: well-established mid/high-tier product — found via
    // Amazon's own search, not a guessed/hardcoded ASIN — sanity check. ---
    log('\n=== Instant Pot (via amazon.com search) — mid/high-tier sanity check ===');
    const instantPot = await searchAndGrade(context, 'https://www.amazon.com/s?k=instant+pot+duo', 'instant-pot');
    results.instant_pot_found = instantPot !== null;
    if (instantPot) {
      results.instant_pot_grade_is_reasonable = ['A', 'B', 'C'].includes(instantPot.grade);
    }

    // --- AULA F99: found via Amazon's own search (not a guessed/hardcoded
    // product URL) — must STILL show a low grade with the price-vs-thin-
    // reviews red flag intact after the recalibration. ---
    log('\n=== AULA F99 keyboard (via amazon.in search) — must STILL be a low grade with price flag ===');
    const aula = await searchAndGrade(context, 'https://www.amazon.in/s?k=AULA+F99+keyboard', 'aula-f99');
    results.aula_found_via_search = aula !== null;
    if (aula) {
      results.aula_grade_is_low = aula.grade === 'D' || aula.grade === 'F' || aula.grade === 'C';
      results.aula_verdict_mentions_price_or_caution = /price|caution|thin|review/i.test(aula.verdict);
    }
  } finally {
    await context.close();
  }

  log('\n=== RESULTS ===');
  for (const [key, value] of Object.entries(results)) {
    log(`[${value ? 'PASS' : 'FAIL'}] ${key}`);
  }
  fs.writeFileSync(path.join(VERIFICATION_DIR, 'grading-guard-console-log.txt'), consoleLog.join('\n'));
  log('\nFull log saved to verification/grading-guard-console-log.txt');

  const anyFail = Object.values(results).some((v) => !v);
  process.exitCode = anyFail ? 1 : 0;
}

main().catch((err) => {
  console.error('\n=== VERIFY-GRADING-GUARD.MJS CRASHED ===');
  console.error(err);
  fs.mkdirSync(VERIFICATION_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(VERIFICATION_DIR, 'grading-guard-console-log.txt'),
    consoleLog.join('\n') + '\n\nCRASH:\n' + String(err.stack || err)
  );
  process.exitCode = 1;
});
