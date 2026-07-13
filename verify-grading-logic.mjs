// verify-grading-logic.mjs
//
// Deterministic, non-browser verification of lib/statistical-engine.ts's
// grading logic — complements verify-grading-guard.mjs (which drives real
// Brave against live Amazon, but live listings drift over time: a product
// that had 14 reviews when a bug was first reported may have 1,000+ by the
// time it's re-checked). This transpiles the actual source file with
// esbuild and runs it directly against synthetic ScrapedAmazonPage objects,
// so the price-vs-thin-reviews and J-shape paths can be checked against
// fixed, known inputs instead of a moving live target.
//
// Does NOT fix anything it finds — it only reports.

import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(__dirname, 'lib', 'statistical-engine.ts');
const OUT = path.join(__dirname, '.tmp-statistical-engine.mjs');

const results = {};
function log(line) {
  console.log(line);
}

function basePage(overrides) {
  return {
    asin: 'TEST0000001',
    locale: 'amazon.com',
    url: 'https://www.amazon.com/dp/TEST0000001',
    title: 'Test product',
    averageRating: null,
    totalReviewCount: null,
    productFirstAvailable: null,
    reviews: [],
    ratingHistogram: [],
    reviewsScanned: 0,
    totalReviews: 0,
    price: null,
    priceCurrency: null,
    ...overrides,
  };
}

function makeReviews(count, { verifiedRatio = 0.8, monthsSpread = 12 } = {}) {
  const reviews = [];
  for (let i = 0; i < count; i++) {
    const monthOffset = i % monthsSpread;
    reviews.push({
      id: `r${i}`,
      rating: 5,
      title: `Great product number ${i}`,
      body: `This works well and I am happy with purchase number ${i} overall.`,
      date: `Reviewed in the United States on January ${1 + (i % 28)}, ${2024 - monthOffset}`,
      verified: i / count < verifiedRatio,
      vine: false,
    });
  }
  return reviews;
}

async function main() {
  log('=== Transpiling lib/statistical-engine.ts with esbuild ===');
  await esbuild.build({
    entryPoints: [SOURCE],
    outfile: OUT,
    format: 'esm',
    bundle: false,
    platform: 'node',
    target: 'es2022',
  });

  const { analyzeReviews } = await import(`${pathToFileURL(OUT).href}?t=${Date.now()}`);

  // --- Case 1: Echo-Dot-like — huge population, high rating, heavy 5-star
  // skew with a naturally small 1-star tail (NOT a J-shape) and one unknown
  // signal (price unreadable, as it actually was on the real page). ---
  log('\n=== Case 1: Echo-Dot-like (195k reviews, 4.7★, price unreadable) ===');
  const echoDot = analyzeReviews(basePage({
    averageRating: 4.7,
    totalReviewCount: 195576,
    totalReviews: 195576,
    ratingHistogram: [
      { star: 5, percent: 82 },
      { star: 4, percent: 10 },
      { star: 3, percent: 3 },
      { star: 2, percent: 2 },
      { star: 1, percent: 3 },
    ],
    reviews: makeReviews(30),
    reviewsScanned: 30,
    price: null,
    priceCurrency: null,
  }));
  log(`grade=${echoDot.grade} confidence=${echoDot.confidence} verdict="${echoDot.verdict}"`);
  log(`price check status: ${echoDot.checks.find((c) => c.id === 'price-vs-reviews')?.status}`);
  results.echo_dot_like_grades_a_or_b = echoDot.grade === 'A' || echoDot.grade === 'B';
  results.echo_dot_like_price_excluded_as_unknown = echoDot.checks.find((c) => c.id === 'price-vs-reviews')?.status === 'unknown';

  // --- Case 2: AULA-like — tiny population (14 reviews), high price
  // (₹6,499), MUST still show the price-vs-reviews red flag and land a low
  // grade. This is the exact original bug scenario, fixed in time so it
  // can't drift the way the live listing has. ---
  log('\n=== Case 2: AULA-like (14 reviews, ₹6,499, thin for the price) ===');
  const aula = analyzeReviews(basePage({
    averageRating: 4.3,
    totalReviewCount: 14,
    totalReviews: 14,
    ratingHistogram: [
      { star: 5, percent: 71 },
      { star: 4, percent: 14 },
      { star: 3, percent: 0 },
      { star: 2, percent: 0 },
      { star: 1, percent: 14 },
    ],
    reviews: makeReviews(14),
    reviewsScanned: 14,
    price: 6499,
    priceCurrency: '₹',
  }));
  log(`grade=${aula.grade} confidence=${aula.confidence} verdict="${aula.verdict}"`);
  const aulaPriceCheck = aula.checks.find((c) => c.id === 'price-vs-reviews');
  log(`price check status: ${aulaPriceCheck?.status} — "${aulaPriceCheck?.detail}"`);
  results.aula_like_price_flag_still_fires = aulaPriceCheck?.status === 'risk';
  results.aula_like_grade_is_low = ['C', 'D', 'F'].includes(aula.grade);
  results.aula_like_verdict_is_price_detail = aula.verdict === aulaPriceCheck?.detail;

  // --- Case 3: genuinely manipulated J-shape — moderate population, BOTH
  // extremes inflated (fake 5-star positives + real angry 1-star buyers),
  // hollow middle. Must still fire risk after the recalibration. ---
  log('\n=== Case 3: genuinely manipulated J-shape (2,000 reviews) ===');
  const manipulated = analyzeReviews(basePage({
    averageRating: 3.9,
    totalReviewCount: 2000,
    totalReviews: 2000,
    ratingHistogram: [
      { star: 5, percent: 62 },
      { star: 4, percent: 4 },
      { star: 3, percent: 3 },
      { star: 2, percent: 4 },
      { star: 1, percent: 27 },
    ],
    reviews: makeReviews(30, { verifiedRatio: 0.4 }),
    reviewsScanned: 30,
    price: 45,
    priceCurrency: '$',
  }));
  log(`grade=${manipulated.grade} confidence=${manipulated.confidence} verdict="${manipulated.verdict}"`);
  log(`histogram check status: ${manipulated.checks.find((c) => c.id === 'histogram-shape')?.status}`);
  results.manipulated_jshape_still_flagged = manipulated.checks.find((c) => c.id === 'histogram-shape')?.status === 'risk';

  // --- Case 4: mid-tier — decent rating, decent population, nothing
  // alarming. Sanity check that ordinary products still land in the
  // middle, not artificially pulled up or down. ---
  log('\n=== Case 4: mid-tier (800 reviews, 4.1★) ===');
  const midTier = analyzeReviews(basePage({
    averageRating: 4.1,
    totalReviewCount: 800,
    totalReviews: 800,
    ratingHistogram: [
      { star: 5, percent: 55 },
      { star: 4, percent: 22 },
      { star: 3, percent: 10 },
      { star: 2, percent: 6 },
      { star: 1, percent: 7 },
    ],
    reviews: makeReviews(30),
    reviewsScanned: 30,
    price: 25,
    priceCurrency: '$',
  }));
  log(`grade=${midTier.grade} confidence=${midTier.confidence} verdict="${midTier.verdict}"`);
  results.mid_tier_grade_is_reasonable = ['A', 'B', 'C'].includes(midTier.grade);

  log('\n=== RESULTS ===');
  for (const [key, value] of Object.entries(results)) {
    log(`[${value ? 'PASS' : 'FAIL'}] ${key}`);
  }

  fs.rmSync(OUT, { force: true });
  const anyFail = Object.values(results).some((v) => !v);
  process.exitCode = anyFail ? 1 : 0;
}

main().catch((err) => {
  console.error('\n=== VERIFY-GRADING-LOGIC.MJS CRASHED ===');
  console.error(err);
  fs.rmSync(OUT, { force: true });
  process.exitCode = 1;
});
