import type { DeepAnalysisProvider, ScrapedAmazonPage, StatisticalAnalysis } from './types';

export const SYSTEM_PROMPT = `You are TrustLens, a review-pattern assistant. Use cautious, pattern/confidence language only. Do not accuse a seller, reviewer, brand, product, or review of fraud. Do not claim proof. Respond in plain text only — never use markdown formatting (no **bold**, no *italics*, no # headers, no markdown list markers like - or *).

Output a "quick verdict card", never an essay:
Line 1: one short sentence — the bottom-line verdict, nothing else.
Then 3-5 bullet lines (never more than 5), each its own line, each ONE line only — max about 12-15 words, never a paragraph, never wrapping.
Each bullet starts with exactly one symbol for its sentiment: ✅ positive/reassuring, ⚠️ caution/concern, 🔍 neutral observation, ⭐ standout point.
Lead each bullet with the key word or finding first — no filler like "It appears that" or "One thing to note is".`;

export interface DeepAnalysisInput {
  provider: DeepAnalysisProvider;
  apiKey: string;
  page: ScrapedAmazonPage;
  statistical: StatisticalAnalysis;
}

export async function runDeepAnalysis(input: DeepAnalysisInput): Promise<string> {
  const prompt = buildPrompt(input.page, input.statistical);
  return input.provider === 'gemini'
    ? runGemini(input.apiKey, prompt)
    : runOpenAI(input.apiKey, prompt);
}

function buildPrompt(page: ScrapedAmazonPage, statistical: StatisticalAnalysis): string {
  const reviewLines = page.reviews.slice(0, 12).map((review, index) => {
    return `${index + 1}. ${review.rating ?? 'n/a'} stars | verified=${review.verified} | vine=${review.vine} | date=${review.date ?? 'unknown'} | ${review.title} ${review.body}`.slice(0, 900);
  });

  return [
    `Product: ${page.title}`,
    `ASIN: ${page.asin ?? 'unknown'}`,
    `Average rating: ${page.averageRating ?? 'unknown'}`,
    `Total reviews: ${page.totalReviewCount ?? 'unknown'}`,
    `Product first available: ${page.productFirstAvailable ?? 'unknown'}`,
    `Statistical grade: ${statistical.grade}`,
    `Rule checks: ${statistical.checks.map((check) => `${check.label}: ${check.status} (${check.detail})`).join(' ')}`,
    'Visible review sample:',
    reviewLines.join('\n'),
    [
      'Write the deep dive as a quick verdict card, exactly this shape:',
      'Line 1: one-sentence bottom-line verdict.',
      'Then 3-5 bullets, one short line each (max ~12-15 words), each starting with ✅, ⚠️, 🔍, or ⭐ based on sentiment. Lead with the key word. No paragraphs. Plain text only — no markdown symbols (**, *, #, -, backticks).',
      '',
      'Example of the target shape (do not reuse this content — match the format only):',
      'Likely genuine — natural review pattern, minor cautions.',
      '✅ Natural rating spread, not manipulated',
      '⚠️ A few reports of near-expiry stock — check the date on arrival',
      '🔍 Texture praised as lightweight, absorbs fast',
      '⚠️ Results mixed — patch-test the retinol first',
    ].join('\n'),
  ].join('\n\n');
}

async function runGemini(apiKey: string, prompt: string): Promise<string> {
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
        // Gemini 3.5 Flash thinks by default (thinkingLevel "medium") and
        // those thinking tokens count against maxOutputTokens — with the
        // old 700-token budget, thinking alone could consume the whole
        // budget before any visible text was written, which is what was
        // actually causing the "cuts off mid-sentence" truncation reported.
        // This is a short pattern-analysis task, not one that benefits from
        // heavy reasoning, so thinking is capped low and the budget is
        // raised to comfortably cover thinking + the full visible answer.
        thinkingConfig: { thinkingLevel: 'low' },
        maxOutputTokens: 1536,
        temperature: 0.2,
      },
    }),
  });
  if (!response.ok) throw new Error(`Gemini deep dive failed (${response.status}).`);
  const payload = await response.json();

  const candidate = payload.candidates?.[0];
  if (candidate?.finishReason === 'MAX_TOKENS') {
    console.warn('[TrustLens] Gemini deep-dive response hit MAX_TOKENS and was truncated.', payload.usageMetadata);
  }

  const text = candidate?.content?.parts?.map((part: { text?: string }) => part.text).join('').trim();
  return stripMarkdown(text) || 'No deep-dive text returned.';
}

async function runOpenAI(apiKey: string, prompt: string): Promise<string> {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-5-mini',
      instructions: SYSTEM_PROMPT,
      input: prompt,
      // Explicit "minimal" rather than relying on the model's default —
      // reasoning tokens count against max_output_tokens on GPT-5-series
      // models the same way Gemini's thinking tokens do, so an unset
      // default is one config change away from the same truncation bug.
      reasoning: { effort: 'minimal' },
      max_output_tokens: 1536,
    }),
  });
  if (!response.ok) throw new Error(`OpenAI deep dive failed (${response.status}).`);
  const payload = await response.json();

  if (payload.status === 'incomplete') {
    console.warn('[TrustLens] OpenAI deep-dive response was incomplete.', payload.incomplete_details);
  }

  const text = payload.output_text
    || payload.output?.flatMap((item: { content?: { text?: string }[] }) => item.content ?? []).map((content: { text?: string }) => content.text).join('').trim();
  return stripMarkdown(text) || 'No deep-dive text returned.';
}

// Defense-in-depth: the prompt asks for plain text, but LLMs don't reliably
// follow "no markdown" instructions for emphasis, and a response cut off
// mid-token can leave an unpaired ** with no closing match for the paired
// stripping passes below to catch — so a final unconditional sweep removes
// any markdown-ish symbol still standing.
function stripMarkdown(text: string | undefined): string {
  if (!text) return '';
  return text
    .replace(/(\*\*|__)(.*?)\1/gs, '$2')
    .replace(/(\*|_)(.*?)\1/gs, '$2')
    .replace(/^#{1,6}\s+/gm, '')
    // Stray list-marker habits (numbered "1. " or dash/dot bullets) the
    // model might still lead a line with instead of/before the sentiment
    // emoji the prompt asks for — emoji themselves (✅ ⚠️ 🔍 ⭐) are
    // untouched by any pass here, only ASCII markdown punctuation is.
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
    .replace(/[*_#`]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}
