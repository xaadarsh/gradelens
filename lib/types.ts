export type TrustGrade = 'A' | 'B' | 'C' | 'D' | 'F' | 'Insufficient data';

export type CheckStatus = 'pass' | 'watch' | 'risk' | 'unknown';

/** How much weight the grade itself can bear — a "B" from 2,000 reviews and a "B" from 14 are not the same claim, so this rides alongside the grade rather than being folded into it. */
export type ConfidenceLevel = 'High' | 'Moderate' | 'Low';

export type DeepAnalysisProvider = 'gemini' | 'openai';

// Settings-page-only preference — TrustPanel and Popup are hard-locked to
// light (see components/TrustPanel.tsx, entrypoints/popup/App.tsx) since
// they render on top of Amazon's always-white pages.
export type ThemePreference = 'light' | 'dark';

export interface ReviewSample {
  id: string;
  rating: number | null;
  title: string;
  body: string;
  date: string | null;
  verified: boolean;
  vine: boolean;
}

/** One row of Amazon's star-rating histogram (e.g. "54% gave 5 stars"), computed by Amazon from the full review population — not TrustLens's small scraped sample. */
export interface RatingHistogramEntry {
  star: 1 | 2 | 3 | 4 | 5;
  /** 0-100. */
  percent: number;
}

export interface ScrapedAmazonPage {
  asin: string | null;
  locale: string;
  url: string;
  title: string;
  averageRating: number | null;
  totalReviewCount: number | null;
  productFirstAvailable: string | null;
  reviews: ReviewSample[];
  /** Star-by-star population breakdown. Empty if fewer than 3 of the 5 levels could be read (page variant TrustLens doesn't recognize) — the grading engine falls back to averageRating/totalReviewCount alone in that case. */
  ratingHistogram: RatingHistogramEntry[];
  /** Explicit count of reviews actually scraped — mirrors reviews.length, kept as its own field for UI/API stability as this grows across the lazy-load and additional-page-fetch enhancements. */
  reviewsScanned: number;
  /** Convenience non-null alias of totalReviewCount, for "Based on N reviews" display. */
  totalReviews: number;
}

export interface RuleCheckResult {
  id: string;
  label: string;
  status: CheckStatus;
  score: number;
  detail: string;
}

export interface StatisticalAnalysis {
  grade: TrustGrade;
  score: number | null;
  sampleSize: number;
  checks: RuleCheckResult[];
  disclaimer: string;
  /** High/Moderate/Low — how much population/sample evidence backs the grade, independent of what the grade itself says. */
  confidence: ConfidenceLevel;
  /** One plain-language sentence telling the shopper what to actually do with this grade — a decision, not a report card. */
  verdict: string;
}

export interface StoredSettings {
  geminiKey?: string;
  openaiKey?: string;
  provider: DeepAnalysisProvider;
  devProOverride: boolean;
  enabled: boolean;
  theme: ThemePreference;
}

export interface LicenseStatus {
  pro: boolean;
  licenseKey?: string;
  checkedAt?: number;
  nextCheckAt?: number;
  message: string;
}

export interface KeyTestResult {
  ok: boolean;
  message: string;
}
