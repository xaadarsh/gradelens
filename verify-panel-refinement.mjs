// verify-panel-refinement.mjs — verifies the 8-item panel refinement pass:
//   1. AI deep-dive never contradicts the engine's own confidence chip —
//      the mocked response DELIBERATELY includes banned confidence language
//      and an over-length headline, so this deterministically exercises the
//      real stripConfidenceLanguage/truncateWords code paths rather than
//      hoping a live model happens to comply.
//   2. Signal chips read as plain human phrases ("Looks fine"), not
//      PASS/WATCH/RISK CI-style enum text.
//   3. Price-vs-review-count signal present, and fires on the AULA F99
//      (14 reviews, ₹6,499) case specifically, folded into the verdict.
//   4. Grade medallion visually softened (lighter fill) when confidence is
//      Low, vs. solid ink fill when High.
//   5. Deep-dive emphasis capped at <=3 words per span, and the three
//      sentiment tints are genuinely distinct computed colours.
//   6. Deep-dive headline capped (mocked response sends an intentionally
//      long one; asserts the rendered text is short).
//   7. (prompt-engineering change — verified by reading the shipped prompt
//      text, not independently live-testable without a real API call)
//   8. Disclaimer starts as one line; (i) toggle reveals the full text.
//
// Real Brave via Playwright, PRODUCTION build only. Three product tiers,
// real amazon.in / amazon.com, both light and dark Settings mode.

import { chromium } from '@playwright/test';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.join(__dirname, '.output', 'chrome-mv3');
const USER_DATA_DIR = path.join(__dirname, '.tmp-brave-panel-refinement-profile');
const VERIFICATION_DIR = path.join(__dirname, 'verification');
const BRAVE_PATH = 'C:/Users/Asus/AppData/Local/BraveSoftware/Brave-Browser/Application/brave.exe';

const PRODUCTS = [
  { key: 'high', label: 'Instant Pot (amazon.com, 185k+ reviews)', url: 'https://www.amazon.com/dp/B00FLYWNYQ' },
  { key: 'mid', label: 'Pilgrim night cream (amazon.in, ~1,920 reviews)', url: 'https://www.amazon.in/dp/B08RQJKF6D' },
  { key: 'low', label: 'AULA F99 keyboard (amazon.in, ~14 reviews, ~₹6,499)', url: 'https://www.amazon.in/dp/B0FV36VB75' },
];

// Deliberately violates the new rules GradeLens's code is supposed to
// defend against: banned confidence language + an over-length headline,
// and one emphasis span longer than 3 words. If the filters work, none of
// this survives to the rendered DOM.
const MOCK_DEEPDIVE_VIOLATIONS = [
  'Moderate confidence based on a fairly small sample size across these reviews with more context needed honestly today.',
  '✅ **Verified purchases dominate the entire sample and this whole pattern here**, not incentivized reviews at all',
  '⚠️ A cluster of reviews **posted the same week**',
  '🔍 Similar phrasing appears across **a few reviews**',
  '⭐ Rating shape declines naturally, **no artificial spike** detected',
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
  const AMAZON_NATIVE_NOISE = /SushiLogger|NoriLogger|Failed to load resource/i;
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !AMAZON_NATIVE_NOISE.test(msg.text())) consoleErrors.push(msg.text());
  });

  const result = { key: product.key, label: product.label, url: product.url };

  try {
    await page.goto(product.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await clickThroughInterstitial(page);

    const panel = page.locator('#gradelens-root .gradelens-panel');
    await panel.waitFor({ state: 'visible', timeout: 20000 });
    await page.waitForTimeout(2500);

    // --- item 4: medallion fill vs confidence ---
    result.confidenceLevel = await page.locator('.gradelens-confidence-chip').getAttribute('data-level').catch(() => null);
    result.medallionBg = await page.locator('.gradelens-medallion').evaluate((node) => getComputedStyle(node).backgroundColor).catch(() => null);

    // --- item 2: chip labels are human phrases ---
    const chipTexts = await page.locator('.gradelens-check-chip').allTextContents();
    result.chipTexts = chipTexts;
    result.chipsAreHuman = chipTexts.length > 0 && chipTexts.every((t) => !/^(PASS|WATCH|RISK|UNKNOWN)$/i.test(t.trim()));

    // --- item 3: price-vs-reviews signal ---
    const checkLabels = await page.locator('.gradelens-check-label').allTextContents();
    result.hasPriceCheck = checkLabels.some((l) => /price/i.test(l));
    result.verdictText = (await page.locator('.gradelens-verdict').textContent().catch(() => ''))?.trim();
    result.priceFlagInVerdict = /price|₹|\$/i.test(result.verdictText ?? '');

    // --- item 8: disclaimer collapsed by default, toggle works ---
    const shortDisclaimer = (await page.locator('.gradelens-disclaimer').textContent().catch(() => ''))?.trim();
    result.shortDisclaimer = shortDisclaimer;
    result.disclaimerIsShort = (shortDisclaimer?.length ?? 999) < 60;
    result.fullDisclaimerHiddenByDefault = (await page.locator('.gradelens-disclaimer-full').count()) === 0;
    await page.locator('.gradelens-disclaimer-info').click();
    await page.waitForTimeout(200);
    const fullDisclaimer = (await page.locator('.gradelens-disclaimer-full').textContent().catch(() => ''))?.trim();
    result.fullDisclaimerAfterToggle = fullDisclaimer;
    result.toggleRevealsFullText = (fullDisclaimer?.length ?? 0) > shortDisclaimer.length;

    await panel.screenshot({ path: path.join(VERIFICATION_DIR, `refine-${product.key}-panel.png`) });

    // --- items 1, 5, 6: mocked AI response with deliberate violations ---
    await page.route('**generativelanguage.googleapis.com/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          candidates: [{ content: { parts: [{ text: MOCK_DEEPDIVE_VIOLATIONS }] }, finishReason: 'STOP' }],
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

      const headline = (await page.locator('.gradelens-deepdive-verdict').textContent().catch(() => ''))?.trim() ?? '';
      result.deepDiveHeadline = headline;
      result.headlineWordCount = headline.replace(/…$/, '').split(/\s+/).filter(Boolean).length;
      result.headlineCapped = result.headlineWordCount <= 12;
      result.headlineHasEllipsis = headline.endsWith('…');

      const fullDeepDiveText = (await page.locator('.gradelens-deep-dive').textContent().catch(() => '')) ?? '';
      result.noConfidenceLanguageLeaked = !/\b(high|moderate|medium|low)[- ]confidence\b|small\s+sample|confidence\s+(?:is|level)/i.test(fullDeepDiveText);

      const emphSpans = page.locator('.gradelens-emph');
      const emphCount = await emphSpans.count();
      const spanDetails = [];
      for (let i = 0; i < emphCount; i++) {
        const el = emphSpans.nth(i);
        const spanText = (await el.textContent())?.trim() ?? '';
        spanDetails.push({
          sentiment: await el.getAttribute('data-sentiment'),
          text: spanText,
          wordCount: spanText.split(/\s+/).filter(Boolean).length,
          color: await el.evaluate((node) => getComputedStyle(node).color),
        });
      }
      result.emphasisSpans = spanDetails;
      result.allEmphasisCapped = spanDetails.every((s) => s.wordCount <= 3);
      const distinctColors = new Set(spanDetails.map((s) => s.color));
      result.sentimentColorsDistinct = distinctColors.size >= Math.min(3, new Set(spanDetails.map((s) => s.sentiment)).size);

      await panel.screenshot({ path: path.join(VERIFICATION_DIR, `refine-${product.key}-deepdive.png`) });
    } else {
      result.deepDiveSkipped = 'button disabled (Insufficient data grade)';
    }

    result.consoleErrors = consoleErrors;
    result.noErrors = consoleErrors.length === 0;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    console.log('FAILED:', result.error);
    await page.screenshot({ path: path.join(VERIFICATION_DIR, `refine-${product.key}-fail.png`) }).catch(() => {});
  } finally {
    await page.close();
  }

  return result;
}

async function verifyDarkModeStaysLightLocked(context, extensionId) {
  const optionsPage = await context.newPage();
  await optionsPage.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: 'domcontentloaded' });
  await optionsPage.waitForTimeout(500);
  const darkBtn = optionsPage.locator('button:has-text("Dark")');
  if ((await darkBtn.count()) > 0) await darkBtn.click();
  await optionsPage.waitForTimeout(300);
  await optionsPage.close();

  const page = await context.newPage();
  await page.goto('https://www.amazon.in/dp/B0FV36VB75', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await clickThroughInterstitial(page);
  const panel = page.locator('#gradelens-root .gradelens-panel');
  await panel.waitFor({ state: 'visible', timeout: 20000 });
  await page.waitForTimeout(2000);
  const cardBg = await page.locator('.gradelens-panel').evaluate((node) => getComputedStyle(node).backgroundColor);
  await panel.screenshot({ path: path.join(VERIFICATION_DIR, 'refine-aula-with-settings-dark.png') });
  await page.close();

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

  try {
    if (extensionId) {
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
    console.log(`  confidence=${r.confidenceLevel}  medallionBg=${r.medallionBg}`);
    console.log(`  [item2] chip texts: ${JSON.stringify(r.chipTexts)}  human=${r.chipsAreHuman}`);
    console.log(`  [item3] has price check row=${r.hasPriceCheck}  verdict="${r.verdictText}"  priceFlagInVerdict=${r.priceFlagInVerdict}`);
    console.log(`  [item8] short="${r.shortDisclaimer}" (short=${r.disclaimerIsShort})  hiddenByDefault=${r.fullDisclaimerHiddenByDefault}  toggleReveals=${r.toggleRevealsFullText}`);
    if (r.deepDiveSkipped) {
      console.log(`  [deep-dive] SKIPPED: ${r.deepDiveSkipped}`);
    } else {
      console.log(`  [item6] headline="${r.deepDiveHeadline}" words=${r.headlineWordCount} capped=${r.headlineCapped} ellipsis=${r.headlineHasEllipsis}`);
      console.log(`  [item1] no confidence language leaked into deep-dive=${r.noConfidenceLanguageLeaked}`);
      console.log(`  [item5] emphasis spans capped<=3 words=${r.allEmphasisCapped}  distinct sentiment colors=${r.sentimentColorsDistinct}`);
      console.log(`  [item5] spans: ${JSON.stringify(r.emphasisSpans)}`);
    }
    console.log(`  [item4-adjacent] no console errors=${r.noErrors} (${r.consoleErrors?.length ?? 0})`);
    if (r.consoleErrors?.length) console.log(`    ${JSON.stringify(r.consoleErrors)}`);
  }

  console.log(`\n[dark] AULA panel stays light-locked with Settings dark mode on: ${darkModeResult?.isLight} (bg=${darkModeResult?.cardBg})`);

  // Cross-product medallion softening comparison (item 4): the Low-
  // confidence product's medallion background should differ from a High-
  // confidence product's solid-ink fill.
  const high = results.find((r) => r.key === 'high');
  const low = results.find((r) => r.key === 'low');
  if (high?.medallionBg && low?.medallionBg) {
    console.log(`\n[item4] High-confidence medallion bg: ${high.medallionBg}`);
    console.log(`[item4] Low-confidence medallion bg:  ${low.medallionBg}`);
    console.log(`[item4] Medallions visually differ by confidence: ${high.medallionBg !== low.medallionBg}`);
  }

  fs.writeFileSync(path.join(VERIFICATION_DIR, 'panel-refinement-report.json'), JSON.stringify({ results, darkModeResult }, null, 2));
  console.log('\nReport written to verification/panel-refinement-report.json');
}

main().catch((err) => {
  console.error('CRASHED:', err);
  process.exitCode = 1;
});
