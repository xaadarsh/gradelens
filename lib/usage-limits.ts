import { ensureStorageMigrated } from './storage-migration';

const USAGE_KEY = 'gradelens_ai_uses';

export const FREE_TRIAL_LIMIT = 5;

async function getUsageCount(): Promise<number> {
  await ensureStorageMigrated();
  const stored = await browser.storage.local.get(USAGE_KEY);
  const value = Number(stored[USAGE_KEY] ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export async function getRemainingTrials(): Promise<number> {
  const used = await getUsageCount();
  return Math.max(0, FREE_TRIAL_LIMIT - used);
}

export async function hasTrialsLeft(): Promise<boolean> {
  return (await getRemainingTrials()) > 0;
}

export async function incrementUsage(): Promise<number> {
  const used = await getUsageCount();
  const next = used + 1;
  await browser.storage.local.set({ [USAGE_KEY]: next });
  return next;
}
