// verify-ai-error-handling.mjs
//
// Live automated verification (real installed Brave, real extension build,
// same convention as verify.mjs) for the shared AI error-classification +
// retry funnel in lib/ai-request.ts, exercised through both callers:
//   - the "Test connection" button (Settings -> lib/byo-key.ts)
//   - the real "Run AI deep dive" flow (TrustPanel -> lib/deep-analysis.ts)
//
// Network calls to Gemini/OpenAI are never made for real here — every case
// mocks the fetch via Playwright route interception so the exact status
// code / body / network failure for each scenario is fully controlled and
// the retry count can be counted precisely.
//
// Does NOT fix anything it finds — it only reports.

import { chromium } from '@playwright/test';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.join(__dirname, '.output', 'chrome-mv3');
const USER_DATA_DIR = path.join(__dirname, '.tmp-brave-profile-ai-errors');
const VERIFICATION_DIR = path.join(__dirname, 'verification');
const BRAVE_PATH = 'C:\\Users\\Asus\\AppData\\Local\\BraveSoftware\\Brave-Browser\\Application\\brave.exe';
const PRODUCT_URL = process.env.TL_VERIFY_URL || 'https://www.amazon.com/dp/B00FLYWNYQ';

const GEMINI_PATTERN = '**/generativelanguage.googleapis.com/**';
const OPENAI_PATTERN = '**/api.openai.com/**';

const results = {};
const consoleLog = [];

function log(line) {
  console.log(line);
  consoleLog.push(line);
}

function record(name, pass, detail) {
  results[name] = pass;
  log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

async function clickThroughAmazonInterstitial(page) {
  const continueBtn = page.locator('button:has-text("Continue shopping"), input[value="Continue shopping"]');
  if ((await continueBtn.count()) > 0) {
    await continueBtn.first().click();
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }
}

// --- Mocked route factories -------------------------------------------------

function statusRoute(status, bodyObj) {
  let attempts = 0;
  const handler = async (route) => {
    attempts += 1;
    await route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(bodyObj ?? { error: { code: status, message: 'mocked', status: 'MOCKED' } }),
    });
  };
  return { handler, attempts: () => attempts };
}

function networkThrowRoute() {
  let attempts = 0;
  const handler = async (route) => {
    attempts += 1;
    await route.abort('failed');
  };
  return { handler, attempts: () => attempts };
}

function sequenceRoute(steps) {
  let attempts = 0;
  const handler = async (route) => {
    const step = steps[Math.min(attempts, steps.length - 1)];
    attempts += 1;
    if (step.abort) {
      await route.abort('failed');
      return;
    }
    await route.fulfill({
      status: step.status,
      contentType: 'application/json',
      body: JSON.stringify(step.body ?? { error: { code: step.status, message: 'mocked', status: 'MOCKED' } }),
    });
  };
  return { handler, attempts: () => attempts };
}

const OVERLOADED_BODY = { error: { code: 503, message: 'The model is overloaded. Please try again later.', status: 'UNAVAILABLE' } };
const KEY_REJECTED_BODY = { error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } };
const RATE_LIMIT_BODY = { error: { code: 429, message: 'Resource has been exhausted (e.g. check quota).', status: 'RESOURCE_EXHAUSTED' } };
const OPENAI_UNAVAILABLE_BODY = { error: { message: 'The server is currently overloaded.', type: 'server_error', code: 'overloaded' } };
const GEMINI_SUCCESS_BODY = { candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'OK' }] } }] };
const GEMINI_DEEPDIVE_SUCCESS_BODY = {
  candidates: [{
    finishReason: 'STOP',
    content: { parts: [{ text: 'Reviews look mostly organic overall.\n✅ **Verified purchases** dominate the sample\n⚠️ A **timing cluster** is worth a look\n🔍 Similar phrasing in a **few reviews**' }] },
  }],
};

// --- Settings-page "Test connection" scenarios ------------------------------

async function clickTestAndAwaitSettled(page) {
  const testBtn = page.locator('button[title="Test connection"]');
  await testBtn.click();
  await page.waitForFunction(() => {
    const btn = document.querySelector('button[title="Test connection"]');
    return btn && btn.disabled;
  }, { timeout: 3000 }).catch(() => {});
  await page.waitForFunction(() => {
    const btn = document.querySelector('button[title="Test connection"]');
    return btn && !btn.disabled;
  }, { timeout: 25000 });
  return (await page.locator('.key-row-feedback').textContent().catch(() => '') ?? '').trim();
}

async function runTestScenario(page, { name, pattern, route, assertMessage, expectedAttempts }) {
  await page.route(pattern, route.handler);
  try {
    const message = await clickTestAndAwaitSettled(page);
    const messageOk = assertMessage(message);
    const attempts = route.attempts();
    const attemptsOk = attempts === expectedAttempts;
    record(name, messageOk && attemptsOk, `message="${message}" attempts=${attempts} (expected ${expectedAttempts})`);
  } finally {
    await page.unroute(pattern, route.handler);
  }
}

// --- Deep-dive scenarios -----------------------------------------------------

async function readTrialsRemaining(page) {
  const text = (await page.locator('.gradelens-trials-inline').textContent().catch(() => '')) ?? '';
  const match = text.match(/(\d+)\s+of/);
  return match ? Number(match[1]) : null;
}

async function clickDeepDiveAndAwaitSettled(page) {
  const btn = page.locator('.gradelens-button');
  await btn.click();
  await page.waitForFunction(() => {
    const button = document.querySelector('.gradelens-button');
    return button && button.disabled;
  }, { timeout: 3000 }).catch(() => {});
  await page.waitForFunction(() => {
    const button = document.querySelector('.gradelens-button');
    return button && !button.disabled;
  }, { timeout: 30000 });
  const status = (await page.locator('.gradelens-status').textContent().catch(() => '')) ?? '';
  const deepDive = (await page.locator('.gradelens-deep-dive').count()) > 0;
  return { status: status.trim(), deepDive };
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
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
    ],
  });

  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
  if (!sw) throw new Error('Could not find the extension service worker — extension may not have loaded.');
  const extensionId = new URL(sw.url()).hostname;
  log(`Extension ID resolved: ${extensionId}`);

  try {
    // --- Settings: save a fake Gemini key so the deep-dive path has a key to use ---
    const optionsPage = await context.newPage();
    await optionsPage.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: 'domcontentloaded' });
    await optionsPage.waitForTimeout(300);

    const geminiInput = optionsPage.locator('input[placeholder="Paste API key"]');
    await geminiInput.click();
    await geminiInput.fill('FAKE-GEMINI-KEY-FOR-VERIFICATION-0000');
    await optionsPage.locator('button[title="Save key"]').click();
    await optionsPage.waitForTimeout(300);
    const saveFeedback = (await optionsPage.locator('.key-row-feedback').textContent().catch(() => '')) ?? '';
    record('gemini_key_saved', /saved/i.test(saveFeedback), saveFeedback.trim());

    log('\n=== "Test connection" scenarios (Gemini) — shared classify+retry funnel ===');

    await runTestScenario(optionsPage, {
      name: 'test_503_overloaded_message_retried_3x',
      pattern: GEMINI_PATTERN,
      route: statusRoute(503, OVERLOADED_BODY),
      assertMessage: (m) => m.includes('Gemini') && /overload/i.test(m) && !/rejected/i.test(m),
      expectedAttempts: 3,
    });

    await runTestScenario(optionsPage, {
      name: 'test_400_key_rejected_not_retried',
      pattern: GEMINI_PATTERN,
      route: statusRoute(400, KEY_REJECTED_BODY),
      assertMessage: (m) => /rejected/i.test(m) && !/overload/i.test(m),
      expectedAttempts: 1,
    });

    await runTestScenario(optionsPage, {
      name: 'test_429_rate_limit_not_retried',
      pattern: GEMINI_PATTERN,
      route: statusRoute(429, RATE_LIMIT_BODY),
      assertMessage: (m) => /rate limit/i.test(m) && !/rejected/i.test(m),
      expectedAttempts: 1,
    });

    await runTestScenario(optionsPage, {
      name: 'test_network_throw_timeout_message_retried',
      pattern: GEMINI_PATTERN,
      route: networkThrowRoute(),
      assertMessage: (m) => /timed out|connection/i.test(m),
      expectedAttempts: 3,
    });

    await runTestScenario(optionsPage, {
      name: 'test_200_success',
      pattern: GEMINI_PATTERN,
      route: statusRoute(200, GEMINI_SUCCESS_BODY),
      assertMessage: (m) => /key works/i.test(m),
      expectedAttempts: 1,
    });

    await runTestScenario(optionsPage, {
      name: 'test_503_then_200_succeeds_via_retry',
      pattern: GEMINI_PATTERN,
      route: sequenceRoute([{ status: 503, body: OVERLOADED_BODY }, { status: 200, body: GEMINI_SUCCESS_BODY }]),
      assertMessage: (m) => /key works/i.test(m),
      expectedAttempts: 2,
    });

    log('\n=== "Test connection" scenario (OpenAI) — proves provider-label substitution isn\'t Gemini-only ===');
    await optionsPage.locator('button:has-text("OpenAI")').first().click();
    await optionsPage.waitForTimeout(200);
    const openaiInput = optionsPage.locator('input[placeholder="Paste API key"]');
    await openaiInput.click();
    await openaiInput.fill('sk-FAKE-OPENAI-KEY-FOR-VERIFICATION-0000');
    await optionsPage.locator('button[title="Save key"]').click();
    await optionsPage.waitForTimeout(300);

    await runTestScenario(optionsPage, {
      name: 'test_openai_503_overloaded_message_retried_3x',
      pattern: OPENAI_PATTERN,
      route: statusRoute(503, OPENAI_UNAVAILABLE_BODY),
      assertMessage: (m) => m.includes('OpenAI') && /overload/i.test(m) && !/rejected/i.test(m),
      expectedAttempts: 3,
    });

    // Switch the provider tab back to Gemini before leaving Settings —
    // clicking the OpenAI tab above persisted provider:'openai' to storage
    // (AIProviderSetup's updateProvider saves immediately on tab click), and
    // the deep-dive scenarios below assume the Gemini key/mock are active.
    await optionsPage.locator('button:has-text("Gemini")').first().click();
    await optionsPage.waitForTimeout(200);
    await optionsPage.close();

    // --- Deep dive on a live Amazon page --------------------------------------
    log('\n=== Deep-dive flow on a live Amazon page (trial-count behavior) ===');
    const amazonPage = await context.newPage();
    await amazonPage.goto(PRODUCT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await clickThroughAmazonInterstitial(amazonPage);
    await amazonPage.waitForTimeout(3000);

    const panelLocator = amazonPage.locator('#gradelens-root .gradelens-panel');
    let panelVisible = false;
    try {
      await panelLocator.waitFor({ state: 'visible', timeout: 20000 });
      panelVisible = true;
    } catch {
      panelVisible = false;
    }
    log(`Panel visible: ${panelVisible}. Waiting ~11s for organic accumulation to produce a real grade...`);
    if (panelVisible) await amazonPage.waitForTimeout(11000);

    const gradeText = panelVisible ? ((await amazonPage.locator('.gradelens-medallion-letter').textContent().catch(() => '')) ?? '') : '';
    const deepDiveEnabled = panelVisible && (await amazonPage.locator('.gradelens-button').isEnabled().catch(() => false));

    if (!panelVisible || !deepDiveEnabled) {
      log('SOFT FAIL: panel not visible or deep-dive button disabled (insufficient live Amazon sample) — skipping deep-dive assertions rather than crashing.');
      record('deepdive_503_all_retries_fail_trial_unchanged', false, 'skipped — panel/grade unavailable');
      record('deepdive_503_then_200_success_trial_decremented_once', false, 'skipped — panel/grade unavailable');
    } else {
      const trialsBefore = await readTrialsRemaining(amazonPage);
      log(`Trials before any deep dive: ${trialsBefore}`);

      // Scenario: every attempt 503s — must exhaust all 3 retries, show the
      // overloaded (not "key rejected") message, and NOT consume a trial.
      const failRoute = statusRoute(503, OVERLOADED_BODY);
      await amazonPage.route(GEMINI_PATTERN, failRoute.handler);
      const failResult = await clickDeepDiveAndAwaitSettled(amazonPage);
      await amazonPage.unroute(GEMINI_PATTERN, failRoute.handler);
      const trialsAfterFail = await readTrialsRemaining(amazonPage);
      const failMessageOk = failResult.status.includes('Gemini') && /overload/i.test(failResult.status) && !/rejected/i.test(failResult.status);
      const failAttemptsOk = failRoute.attempts() === 3;
      const failTrialOk = trialsAfterFail === trialsBefore;
      record(
        'deepdive_503_all_retries_fail_trial_unchanged',
        failMessageOk && failAttemptsOk && failTrialOk,
        `status="${failResult.status}" attempts=${failRoute.attempts()} trials ${trialsBefore}->${trialsAfterFail}`,
      );

      // Reload for a fresh TrustPanel mount, then: attempt 1 -> 503, attempt 2 -> 200.
      // Must ultimately succeed and decrement the trial count exactly once.
      await amazonPage.reload({ waitUntil: 'domcontentloaded' });
      await clickThroughAmazonInterstitial(amazonPage);
      await amazonPage.waitForTimeout(3000);
      await amazonPage.locator('#gradelens-root .gradelens-panel').waitFor({ state: 'visible', timeout: 20000 }).catch(() => {});
      await amazonPage.waitForTimeout(11000);

      const successRoute = sequenceRoute([{ status: 503, body: OVERLOADED_BODY }, { status: 200, body: GEMINI_DEEPDIVE_SUCCESS_BODY }]);
      await amazonPage.route(GEMINI_PATTERN, successRoute.handler);
      const successResult = await clickDeepDiveAndAwaitSettled(amazonPage);
      await amazonPage.unroute(GEMINI_PATTERN, successRoute.handler);
      const trialsAfterSuccess = await readTrialsRemaining(amazonPage);
      const successOk = successResult.deepDive && successResult.status === '';
      const successAttemptsOk = successRoute.attempts() === 2;
      const successTrialOk = trialsAfterSuccess === trialsAfterFail - 1;
      record(
        'deepdive_503_then_200_success_trial_decremented_once',
        successOk && successAttemptsOk && successTrialOk,
        `deepDiveShown=${successResult.deepDive} attempts=${successRoute.attempts()} trials ${trialsAfterFail}->${trialsAfterSuccess}`,
      );
    }

    await amazonPage.close();
  } finally {
    await context.close();
  }

  log('\n=== RESULTS ===');
  const total = Object.keys(results).length;
  const passed = Object.values(results).filter(Boolean).length;
  for (const [key, value] of Object.entries(results)) {
    log(`[${value ? 'PASS' : 'FAIL'}] ${key}`);
  }
  log(`\n${passed}/${total} passed`);

  fs.writeFileSync(path.join(VERIFICATION_DIR, 'ai-error-handling-log.txt'), consoleLog.join('\n'));
  log('\nFull log saved to verification/ai-error-handling-log.txt');

  if (passed !== total) process.exitCode = 1;
}

main().catch((err) => {
  console.error('\n=== verify-ai-error-handling.mjs CRASHED ===');
  console.error(err);
  fs.mkdirSync(VERIFICATION_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(VERIFICATION_DIR, 'ai-error-handling-log.txt'),
    consoleLog.join('\n') + '\n\nCRASH:\n' + String(err.stack || err),
  );
  process.exitCode = 1;
});
