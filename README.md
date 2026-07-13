# GradeLens

A Chrome extension (Manifest V3) that grades the trustworthiness of Amazon
product reviews. It reads the page's own rating histogram and review sample,
runs a rule-based statistical engine over them, and surfaces a plain-letter
grade (A–F) directly on the product page — with an optional AI-powered
deep-dive for Pro users.

## How it works

- **Content script** (`entrypoints/content.tsx`) scrapes the visible rating
  histogram, review count, and a sample of reviews from the live Amazon page,
  then renders the grade panel (`components/TrustPanel.tsx`) into the page.
- **Statistical engine** (`lib/statistical-engine.ts`) turns that scrape into
  a grade, confidence level, and a one-line verdict — no network calls, pure
  rule-based scoring.
- **Deep-dive** (`lib/deep-analysis.ts`) is an optional, on-demand LLM call
  (Gemini or OpenAI, user-supplied API key) that expands on the statistical
  grade in plain language. Free users get a limited number of deep-dives
  (`lib/usage-limits.ts`); Pro users (verified via Gumroad, `lib/license.ts`)
  get unlimited use.
- **Popup** (`entrypoints/popup`) is a quick-glance surface: on/off toggle,
  plan badge, trial counter, and recent-checks history.
- **Options page** (`entrypoints/options`) is the full settings surface: BYO
  API keys, provider choice, license activation, appearance, and support
  links.
- **Background** (`entrypoints/background.ts`) is a minimal MV3 service
  worker whose only job is relaying `openOptionsPage()` calls from the
  content script (which can't call it directly).

## Development

```bash
npm install
npm run compile   # tsc --noEmit
npm run build     # production build -> .output/chrome-mv3
```

Load `.output/chrome-mv3` as an unpacked extension via
`chrome://extensions` (Developer mode → Load unpacked). There is no dev-mode
/ HMR workflow — always build and load the production output.

## Verification

`verify.mjs` is the primary end-to-end check: it builds the extension,
launches it in a real installed Brave browser via Playwright, and drives the
popup, options page, and a live Amazon product page. It only reports — it
never modifies code.

```bash
node verify.mjs
```

`verify-license.mjs` covers the Gumroad licensing flow specifically (real
API for invalid keys, mocked success for valid keys, persistence, and
network-failure degradation). Both follow the same real-browser pattern and
are run ad hoc, not as a CI suite.

## Tech stack

React 19, TypeScript, [WXT](https://wxt.dev/) (MV3 extension framework),
Playwright (verification only, not a unit-test suite).
