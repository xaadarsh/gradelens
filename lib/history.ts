import { ensureStorageMigrated } from './storage-migration';
import type { TrustGrade } from './types';

export interface HistoryEntry {
  asin: string;
  title: string;
  grade: TrustGrade;
  /** epoch ms */
  date: number;
}

const HISTORY_KEY = 'gradelens_history';

// Lightweight local-only memory of past checks — no backend, chrome.storage
// only. Capped well below any storage.local quota concern; 100 products is
// already far more than a popup list needs to show.
export const MAX_HISTORY_ENTRIES = 100;

export async function getHistory(): Promise<HistoryEntry[]> {
  await ensureStorageMigrated();
  const stored = await browser.storage.local.get(HISTORY_KEY);
  const list = stored[HISTORY_KEY];
  return Array.isArray(list) ? list : [];
}

// One entry per ASIN, most-recently-graded first — re-checking a product
// (or its grade changing as more reviews stream in) updates that same
// entry in place rather than piling up duplicates.
export async function recordHistoryEntry(entry: HistoryEntry): Promise<void> {
  const existing = await getHistory();
  const deduped = existing.filter((item) => item.asin !== entry.asin);
  const next = [entry, ...deduped].slice(0, MAX_HISTORY_ENTRIES);
  await browser.storage.local.set({ [HISTORY_KEY]: next });
}

export async function clearHistory(): Promise<void> {
  await browser.storage.local.remove(HISTORY_KEY);
}
