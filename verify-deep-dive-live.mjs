// verify-deep-dive-live.mjs — real-key verification of the "quick verdict
// card" shape: 1-line verdict + 3-5 short emoji-led bullets, each with
// exactly one **key-phrase** emphasis span, no other raw markdown. Calls
// the EXACT same endpoint/config/prompt as lib/deep-analysis.ts's
// runGemini(), using a realistic sample product+review dataset, so this
// proves the real prompt works rather than a synthetic mock — a
// complementary check to verify-trust-hardening.mjs, which verifies the
// RENDERING of a mocked response without spending a real API call.
// Prints the full raw response plus the cleaned final text, and checks the
// output actually matches the required shape.
//
// Usage: set the key via an env var, never as a CLI arg (avoids it landing
// in shell history) — e.g.:
//   GEMINI_KEY=AIzaSy... node verify-deep-dive-live.mjs

const apiKey = process.env.GEMINI_KEY;
if (!apiKey) {
  console.error('Set GEMINI_KEY env var first, e.g.: GEMINI_KEY=AIzaSy... node verify-deep-dive-live.mjs');
  process.exit(1);
}

// Kept in exact sync with lib/deep-analysis.ts — copy-pasted, not imported,
// since this is a plain Node script outside the extension's TS build.
const SYSTEM_PROMPT = `You are GradeLens, a review-pattern assistant. Use cautious, pattern/confidence language only. Do not accuse a seller, reviewer, brand, product, or review of fraud. Do not claim proof.

Output a "quick verdict card", never an essay:
Line 1: one short sentence — the bottom-line verdict, nothing else. Plain text, no emphasis markers on this line.
Then 3-5 bullet lines (never more than 5), each its own line, each ONE line only — max about 12-15 words, never a paragraph, never wrapping.
Each bullet starts with exactly one symbol for its sentiment: ✅ positive/reassuring, ⚠️ caution/concern, 🔍 neutral observation, ⭐ standout point.
Lead each bullet with the key word or finding first — no filler like "It appears that" or "One thing to note is".
Within each bullet, wrap the single most important 2-4 word phrase — the key finding — in **double asterisks**. Exactly one such span per bullet, never the whole sentence, never zero.
That double-asterisk span is the ONLY formatting allowed anywhere in the response — no *italics*, no # headers, no - or * list dashes, no backticks.`;

// A realistic stand-in for a scraped Pilgrim-style product + review sample,
// same shape buildPrompt() in lib/deep-analysis.ts produces.
const prompt = [
  'Product: PILGRIM French Red Vine Anti Aging Night Cream',
  'ASIN: B08RQJKF6D',
  'Average rating: 4.1',
  'Total reviews: 1920',
  'Product first available: unknown',
  'Statistical grade: B',
  'Rule checks: Rating distribution shape: pass (54% 5★, 22% 4★, 13% 3★, 4% 2★, 7% 1★ — a natural, gradually declining curve across the full review population.) Overall rating & review volume: watch (4.1 average across 1,920 total reviews is a limited independent signal.)',
  'Visible review sample:',
  [
    '1. 5 stars | verified=true | vine=false | date=2026-05-12 | Great texture Absorbs fast, no greasy feel, noticed brighter skin after 2 weeks.',
    '2. 4 stars | verified=true | vine=false | date=2026-04-30 | Good but pricey Works well but the jar is small for the price.',
    '3. 2 stars | verified=false | vine=false | date=2026-03-18 | Broke me out Caused some breakouts on my chin, had to stop using it.',
    '4. 5 stars | verified=true | vine=false | date=2026-05-02 | Love it Repurchased twice already, skin feels firmer.',
    '5. 3 stars | verified=true | vine=false | date=2026-02-11 | Its ok Nothing special, mild moisturizing effect only.',
  ].join('\n'),
  [
    'Write the deep dive as a quick verdict card, exactly this shape:',
    'Line 1: one-sentence bottom-line verdict, no emphasis markers.',
    'Then 3-5 bullets, one short line each (max ~12-15 words), each starting with ✅, ⚠️, 🔍, or ⭐ based on sentiment. Lead with the key word. No paragraphs.',
    'Within each bullet, wrap the one key 2-4 word phrase in **double asterisks** — exactly one span per bullet. No other markdown symbols anywhere (no *italics*, no #, no - list dashes, no backticks).',
    '',
    'Example of the target shape (do not reuse this content — match the format only):',
    'Likely genuine — natural review pattern, minor cautions.',
    '✅ **Natural rating spread**, not manipulated',
    '⚠️ Reports of **near-expiry stock** — check the date on arrival',
    '🔍 Texture praised as **lightweight, fast-absorbing**',
    '⚠️ **Mixed results** — patch-test the retinol first',
  ].join('\n'),
].join('\n\n');

// Kept in sync with lib/deep-analysis.ts's stripMarkdown — see that file's
// comment for why the placeholder token is delimiter-punctuation-free.
function stripMarkdown(text) {
  if (!text) return '';
  const protectedSpans = [];
  const token = (i) => `@@EMPH${i}@@`;
  let working = text.replace(/\*\*(.+?)\*\*/gs, (_match, inner) => {
    const t = token(protectedSpans.length);
    protectedSpans.push(inner);
    return t;
  });
  working = working
    .replace(/__(.*?)__/gs, '$1')
    .replace(/(\*|_)(.*?)\1/gs, '$2')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
    .replace(/[*_#`]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  return working.replace(/@@EMPH(\d+)@@/g, (_match, index) => `**${protectedSpans[Number(index)]}**`);
}

const SENTIMENT_EMOJI = ['✅', '⚠️', '🔍', '⭐'];

async function main() {
  console.log('=== Calling Gemini 3.5 Flash (same config as lib/deep-analysis.ts) ===\n');

  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        thinkingConfig: { thinkingLevel: 'low' },
        maxOutputTokens: 1536,
        temperature: 0.2,
      },
    }),
  });

  console.log('HTTP status:', response.status);
  const payload = await response.json();

  console.log('\n=== FULL RAW RESPONSE ===');
  console.log(JSON.stringify(payload, null, 2));

  if (!response.ok) {
    console.error('\nRequest failed — see raw response above for the error details.');
    process.exit(1);
  }

  const candidate = payload.candidates?.[0];
  console.log('\n=== finishReason ===', candidate?.finishReason);
  console.log('=== usageMetadata ===', JSON.stringify(payload.usageMetadata, null, 2));

  const rawText = candidate?.content?.parts?.map((part) => part.text).join('').trim();
  console.log('\n=== RAW TEXT (before markdown stripping) ===');
  console.log(rawText);

  const cleaned = stripMarkdown(rawText);
  console.log('\n=== CLEANED TEXT (what the panel will actually show) ===');
  console.log(cleaned);

  console.log('\n=== FORMAT CHECKS ===');
  const lines = cleaned.split('\n').map((l) => l.trim()).filter(Boolean);
  const verdictLine = lines[0] ?? '';
  const bulletLines = lines.slice(1);

  const wasTruncated = candidate?.finishReason === 'MAX_TOKENS';
  console.log('Truncated (finishReason=MAX_TOKENS):', wasTruncated);

  // ** pairs are now intentional (rendered as tinted emphasis spans by
  // TrustPanel), so only flag genuinely stray markdown: unpaired *, any _,
  // #, or backtick, or a ** that isn't part of a well-formed pair.
  const withoutValidEmphasis = cleaned.replace(/\*\*(.+?)\*\*/gs, '');
  const leftoverMarkdown = /[*_#`]/.test(withoutValidEmphasis);
  console.log('Leftover markdown symbols (outside valid ** pairs):', leftoverMarkdown);

  const emphasisSpans = [...cleaned.matchAll(/\*\*(.+?)\*\*/gs)].map((m) => m[1]);
  console.log(`Emphasis spans found: ${emphasisSpans.length} — ${JSON.stringify(emphasisSpans)}`);
  const everyBulletHasOneEmphasis = bulletLines.every((line) => (line.match(/\*\*/g) ?? []).length === 2);
  console.log('Every bullet has exactly one ** span:', everyBulletHasOneEmphasis);

  console.log(`\nVerdict line (1): "${verdictLine}"`);
  const verdictIsOneSentence = verdictLine.length > 0 && verdictLine.length < 160;
  console.log('Verdict line present and short:', verdictIsOneSentence);

  console.log(`\nBullet count: ${bulletLines.length} (must be 3-5)`);
  const bulletCountOk = bulletLines.length >= 3 && bulletLines.length <= 5;

  let allEmojiLed = true;
  let allShortEnough = true;
  bulletLines.forEach((line, i) => {
    const startsWithSentimentEmoji = SENTIMENT_EMOJI.some((e) => line.startsWith(e));
    const wordCount = line.replace(/^\S+\s*/, '').split(/\s+/).filter(Boolean).length;
    const short = wordCount <= 18; // small slack over the requested 12-15
    if (!startsWithSentimentEmoji) allEmojiLed = false;
    if (!short) allShortEnough = false;
    console.log(`  bullet ${i + 1}: emoji-led=${startsWithSentimentEmoji}  words=${wordCount}  "${line}"`);
  });

  console.log('\nAll bullets emoji-led (✅/⚠️/🔍/⭐):', allEmojiLed);
  console.log('All bullets one short line (<=18 words):', allShortEnough);
  console.log('Total cleaned length (chars):', cleaned.length, '(quick-card target: well under 500)');

  const pass = !wasTruncated && !leftoverMarkdown && verdictIsOneSentence && bulletCountOk && allEmojiLed && allShortEnough && everyBulletHasOneEmphasis;
  console.log(pass ? '\nPASS' : '\nFAIL — investigate above');
}

main().catch((err) => {
  console.error('CRASHED:', err);
  process.exitCode = 1;
});
