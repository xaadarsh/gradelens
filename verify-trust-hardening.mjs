// verify-trust-hardening.mjs — verifies the 8-item trust/robustness pass:
//   0.  Disclaimer no longer apologizes for population-sourced grading.
//   0b. Deep-dive renders with real hierarchy (dominant headline + tinted
//       emphasis spans), driven by a mocked AI response (no real API key
//       needed/spent — this tests OUR rendering pipeline deterministically,
//       not the LLM's variance).
//   1.  Confidence chip (High/Moderate/Low) next to the grade.
//   2.  Tap-to-expand signal rows show a plain-language detail line.
//   3.  Actionable verdict sentence below the grade.
//   4.  No console errors / page errors across the whole flow.
//   5.  (source-reviewed: extra mount-anchor fallback + selector-health
//       self-check — not independently live-tested here, see report notes)
//   6.  Local history: popup shows "Recent checks" after grading.
//
// Real Brave via Playwright, PRODUCTION build only (dev mode is known-broken
// and out of scope). Three product tiers, real amazon.in / amazon.com.

import { chromium } from '@playwright/test';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.join(__dirname, '.output', 'chrome-mv3');
const USER_DATA_DIR = path.join(__dirname, '.tmp-brave-trust-hardening-profile');
const VERIFICATION_DIR = path.join(__dirname, 'verification');
const BRAVE_PATH = 'C:/Users/Asus/AppData/Local/BraveSoftware/Brave-Browser/Application/brave.exe';

const PRODUCTS = [
  { key: 'high', label: 'Instant Pot (amazon.com, 185k+ reviews)', url: 'https://www.amazon.com/dp/B00FLYWNYQ' },
  { key: 'mid', label: 'Pilgrim night cream (amazon.in, ~1,920 reviews)', url: 'https://www.amazon.in/dp/B08RQJKF6D' },
  { key: 'low', label: 'AULA F99 keyboard (amazon.in, ~14 reviews)', url: 'https://www.amazon.in/dp/B0FV36VB75' },
];

const MOCK_DEEPDIVE_TEXT = [
  'Likely genuine — natural review pattern, minor cautions worth a look.',
  '✅ **Natural rating spread**, not manipulated across the population',
  '⚠️ A few reports of **near-expiry stock** — check the date on arrival',
  '🔍 Texture praised as **lightweight, fast-absorbing** by most reviewers',
  '⭐ Repeat purchases mentioned — **loyal customer base** forming',
].join('\n');

async function clickThroughInterstitial(page) {
  const continueBtn = page.locator('button:has-text("Continue shopping"), input[value="Continue shopping"]');
  if ((await continueBtn.count()) > 0) {
    await continueBtn.first().click();
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }
}

async function verifyProduct(context, product) {
  console.log(`\n=== ${product.label} ===`);
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  // Amazon's own page is noisy (ad-beacon 404s, its internal SushiLogger/
  // NoriLogger telemetry) regardless of whether GradeLens is installed at
  // all — item 4 cares about errors GradeLens is responsible for, not
  // pre-existing Amazon page noise, so those are filtered from the signal.
  const AMAZON_NATIVE_NOISE = /SushiLogger|NoriLogger|Failed to load resource/i;
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !AMAZON_NATIVE_NOISE.test(msg.text())) consoleErrors.push(msg.text());
    if (msg.text().includes('[GradeLens]')) console.log(`[console] ${msg.text()}`);
  });
  page.on('pageerror', (err) => pageErrors.push(err.message));

  const result = { key: product.key, label: product.label, url: product.url };

  try {
    await page.goto(product.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await clickThroughInterstitial(page);

    const panel = page.locator('#gradelens-root .gradelens-panel');
    await panel.waitFor({ state: 'visible', timeout: 20000 });
    result.panelMounted = true;
    await page.waitForTimeout(2500); // let the medallion sequence + any live re-grade settle

    // --- item 0: disclaimer copy ---
    const disclaimer = (await page.locator('.gradelens-disclaimer').textContent().catch(() => '')) ?? '';
    result.disclaimer = disclaimer.trim();
    result.disclaimerApologizes = /too few individual reviews could be read/i.test(disclaimer);
    result.disclaimerIsPopulationSourced = /full public rating history/i.test(disclaimer);

    // --- item 1: confidence chip ---
    const confidenceChip = page.locator('.gradelens-confidence-chip');
    result.hasConfidenceChip = (await confidenceChip.count()) > 0;
    result.confidenceText = result.hasConfidenceChip ? (await confidenceChip.textContent())?.trim() : null;
    result.confidenceLevel = result.hasConfidenceChip ? await confidenceChip.getAttribute('data-level') : null;

    // --- item 3: verdict line ---
    const verdict = page.locator('.gradelens-verdict');
    result.hasVerdict = (await verdict.count()) > 0;
    result.verdictText = result.hasVerdict ? (await verdict.textContent())?.trim() : null;

    // --- grade / subtitle for context ---
    result.grade = (await page.locator('.gradelens-medallion-letter').textContent().catch(() => ''))?.trim();
    result.subtitle = (await page.locator('.gradelens-subtitle').textContent().catch(() => ''))?.trim();

    await panel.screenshot({ path: path.join(VERIFICATION_DIR, `hardening-${product.key}-panel.png`) });

    // --- item 2: why-expansion ---
    const firstCheckRow = page.locator('.gradelens-check-row').first();
    if ((await firstCheckRow.count()) > 0) {
      await firstCheckRow.click();
      await page.waitForTimeout(300);
      const detail = page.locator('.gradelens-check-detail').first();
      result.expandShowsDetail = (await detail.count()) > 0 && ((await detail.textContent())?.trim().length ?? 0) > 0;
      result.expandDetailSample = (await detail.textContent().catch(() => ''))?.trim().slice(0, 100);
      await firstCheckRow.click();
      await page.waitForTimeout(300);
      result.collapseWorks = (await page.locator('.gradelens-check-detail').count()) === 0;
    } else {
      result.expandShowsDetail = false;
      result.collapseWorks = false;
    }

    // --- item 0b: deep-dive rendering (mocked AI response, real rendering pipeline) ---
    // The mock geminiKey is set once via an extension page before this loop
    // runs (chrome.storage isn't reachable from an ordinary Amazon tab's
    // page.evaluate — that's the content script's isolated-world `browser`,
    // not window.chrome). Just intercept the API call and reload here.
    await page.route('**generativelanguage.googleapis.com/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          candidates: [{ content: { parts: [{ text: MOCK_DEEPDIVE_TEXT }] }, finishReason: 'STOP' }],
        }),
      }),
    );
    await page.reload({ waitUntil: 'domcontentloaded' });
    await clickThroughInterstitial(page);
    await panel.waitFor({ state: 'visible', timeout: 20000 });
    await page.waitForTimeout(2500);

    const deepDiveBtn = page.locator('.gradelens-button');
    if ((await deepDiveBtn.count()) > 0 && !(await deepDiveBtn.isDisabled())) {
      await deepDiveBtn.click();
      await page.locator('.gradelens-deepdive-verdict').waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
      const verdictLine = page.locator('.gradelens-deepdive-verdict');
      result.deepDiveVerdict = (await verdictLine.textContent().catch(() => ''))?.trim() ?? null;

      const emphSpans = page.locator('.gradelens-emph');
      const emphCount = await emphSpans.count();
      result.deepDiveEmphCount = emphCount;
      const sentiments = [];
      for (let i = 0; i < emphCount; i++) {
        const el = emphSpans.nth(i);
        sentiments.push({
          sentiment: await el.getAttribute('data-sentiment'),
          text: (await el.textContent())?.trim(),
          bg: await el.evaluate((node) => getComputedStyle(node).backgroundColor),
        });
      }
      result.deepDiveEmphSpans = sentiments;
      result.deepDiveEmphTinted = sentiments.length > 0 && sentiments.every((s) => s.bg && s.bg !== 'rgba(0, 0, 0, 0)' && s.bg !== 'transparent');
      // No raw ** markers should ever reach the DOM as literal text.
      const bodyText = (await page.locator('.gradelens-deep-dive').textContent().catch(() => '')) ?? '';
      result.deepDiveNoRawAsterisks = !bodyText.includes('**');

      await panel.screenshot({ path: path.join(VERIFICATION_DIR, `hardening-${product.key}-deepdive.png`) });
    } else {
      result.deepDiveSkipped = 'button disabled (Insufficient data grade) — expected for this product/state';
    }

    result.consoleErrors = consoleErrors;
    result.pageErrors = pageErrors;
    result.noErrors = consoleErrors.length === 0 && pageErrors.length === 0;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    console.log('FAILED:', result.error);
    await page.screenshot({ path: path.join(VERIFICATION_DIR, `hardening-${product.key}-fail.png`) }).catch(() => {});
  } finally {
    await page.close();
  }

  return result;
}

async function verifyHistoryInPopup(context, extensionId, expectedTitleFragments) {
  const popupPage = await context.newPage();
  await popupPage.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });
  await popupPage.waitForTimeout(600);
  const historyRows = popupPage.locator('.history-row');
  const count = await historyRows.count();
  const rows = [];
  for (let i = 0; i < count; i++) {
    rows.push({
      grade: (await historyRows.nth(i).locator('.history-grade').textContent().catch(() => ''))?.trim(),
      title: (await historyRows.nth(i).locator('.history-title').textContent().catch(() => ''))?.trim(),
    });
  }
  await popupPage.screenshot({ path: path.join(VERIFICATION_DIR, 'hardening-popup-history.png') });
  await popupPage.close();
  const matchesExpected = expectedTitleFragments.some((frag) => rows.some((r) => r.title?.toLowerCase().includes(frag.toLowerCase())));
  return { historyRowCount: count, historyRows: rows, matchesExpected };
}

async function verifyDarkModeStaysLightLocked(context, extensionId) {
  const optionsPage = await context.newPage();
  await optionsPage.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: 'domcontentloaded' });
  await optionsPage.waitForTimeout(500);
  const darkBtn = optionsPage.locator('button:has-text("Dark")');
  if ((await darkBtn.count()) > 0) await darkBtn.click();
  await optionsPage.waitForTimeout(300);
  await optionsPage.screenshot({ path: path.join(VERIFICATION_DIR, 'hardening-settings-dark.png') });
  await optionsPage.close();

  const page = await context.newPage();
  await page.goto('https://www.amazon.in/dp/B08RQJKF6D', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await clickThroughInterstitial(page);
  const panel = page.locator('#gradelens-root .gradelens-panel');
  await panel.waitFor({ state: 'visible', timeout: 20000 });
  await page.waitForTimeout(2000);
  const cardBg = await page.locator('.gradelens-panel').evaluate((node) => getComputedStyle(node).backgroundColor);
  await panel.screenshot({ path: path.join(VERIFICATION_DIR, 'hardening-panel-with-settings-dark.png') });
  await page.close();

  // Light --card is #FCFBF8 -> rgb(252, 251, 248); dark --card would be #1C1A17 -> rgb(28, 26, 23). Confirm it's the light one.
  const isLight = cardBg === 'rgb(252, 251, 248)';
  return { cardBg, isLight };
}

async function main() {
  console.log('=== Building extension (npm run build) ===');
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
  console.log('Extension ID:', extensionId);

  const results = [];
  let darkModeResult = null;
  let historyResult = null;

  try {
    if (extensionId) {
      // Set a mock Gemini key once, via an extension page (options.html) —
      // chrome.storage is only reachable from privileged extension
      // contexts, not an ordinary Amazon tab's page context.
      const setupPage = await context.newPage();
      await setupPage.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: 'domcontentloaded' });
      await setupPage.evaluate(async () => {
        const stored = await chrome.storage.local.get('gradelens.settings');
        const current = stored['gradelens.settings'] ?? {};
        await chrome.storage.local.set({ 'gradelens.settings': { ...current, provider: 'gemini', geminiKey: 'mock-key-for-verification' } });
      });
      console.log('Mock Gemini key set via options.html storage.');
      await setupPage.close();
    }

    for (const product of PRODUCTS) {
      results.push(await verifyProduct(context, product));
    }

    if (extensionId) {
      historyResult = await verifyHistoryInPopup(context, extensionId, ['Instant Pot', 'PILGRIM', 'AULA']);
      darkModeResult = await verifyDarkModeStaysLightLocked(context, extensionId);
    }
  } finally {
    await context.close();
  }

  console.log('\n\n=== RESULTS ===');
  for (const r of results) {
    console.log(`\n${r.label}`);
    if (r.error) {
      console.log(`  ERROR: ${r.error}`);
      continue;
    }
    console.log(`  grade=${r.grade}  subtitle="${r.subtitle}"`);
    console.log(`  [item0 ] disclaimer apologizes=${r.disclaimerApologizes} (want false) populationSourced=${r.disclaimerIsPopulationSourced}: "${r.disclaimer}"`);
    console.log(`  [item1 ] confidence chip present=${r.hasConfidenceChip} text="${r.confidenceText}" level=${r.confidenceLevel}`);
    console.log(`  [item3 ] verdict present=${r.hasVerdict} text="${r.verdictText}"`);
    console.log(`  [item2 ] expand shows detail=${r.expandShowsDetail} collapse works=${r.collapseWorks} sample="${r.expandDetailSample}"`);
    if (r.deepDiveSkipped) {
      console.log(`  [item0b] SKIPPED: ${r.deepDiveSkipped}`);
    } else {
      console.log(`  [item0b] deep-dive verdict headline="${r.deepDiveVerdict}"`);
      console.log(`  [item0b] emphasis spans=${r.deepDiveEmphCount} tinted=${r.deepDiveEmphTinted} noRawAsterisks=${r.deepDiveNoRawAsterisks}`);
      console.log(`  [item0b] spans: ${JSON.stringify(r.deepDiveEmphSpans)}`);
    }
    console.log(`  [item4 ] no console/page errors=${r.noErrors} (console: ${r.consoleErrors?.length ?? 0}, page: ${r.pageErrors?.length ?? 0})`);
    if (r.consoleErrors?.length) console.log(`    console errors: ${JSON.stringify(r.consoleErrors)}`);
    if (r.pageErrors?.length) console.log(`    page errors: ${JSON.stringify(r.pageErrors)}`);
  }

  console.log(`\n[item6 ] popup history rows=${historyResult?.historyRowCount} matchesExpected=${historyResult?.matchesExpected}`);
  console.log(`         ${JSON.stringify(historyResult?.historyRows)}`);

  console.log(`\n[dark  ] TrustPanel stays light-locked with Settings dark mode on: ${darkModeResult?.isLight} (bg=${darkModeResult?.cardBg})`);

  fs.writeFileSync(
    path.join(VERIFICATION_DIR, 'trust-hardening-report.json'),
    JSON.stringify({ results, historyResult, darkModeResult }, null, 2),
  );
  console.log('\nReport written to verification/trust-hardening-report.json');
}

main().catch((err) => {
  console.error('CRASHED:', err);
  process.exitCode = 1;
});
