// One-time migration for the product rename (old brand's key prefix ->
// "gradelens"): existing installs have data sitting under the old key
// names, and simply switching every read/write in this codebase to the new
// names would make that data invisible — trial count reset to 0, saved API
// keys gone, license and history wiped, from the user's perspective. Each
// old/new pair here is a straight rename, not a schema change.
//
// Idempotent and safe to call from every storage-reading entrypoint
// (content script, popup, options, background — each is a separate JS
// realm with its own module state, so this can't rely on in-memory
// memoization alone): a completed migration is recorded under
// MIGRATION_FLAG_KEY, so every call after the first one across every
// context is a single cheap flag read, not a repeated key-by-key scan.
const MIGRATION_FLAG_KEY = 'gradelens.storageMigrated';

const RENAMED_KEYS: [oldKey: string, newKey: string][] = [
  ['trustlens_ai_uses', 'gradelens_ai_uses'],
  ['trustlens_history', 'gradelens_history'],
  ['trustlens.settings', 'gradelens.settings'],
  ['trustlens.license', 'gradelens.license'],
];

let migrationPromise: Promise<void> | null = null;

export function ensureStorageMigrated(): Promise<void> {
  migrationPromise ??= runMigration();
  return migrationPromise;
}

async function runMigration(): Promise<void> {
  const flagCheck = await browser.storage.local.get(MIGRATION_FLAG_KEY);
  if (flagCheck[MIGRATION_FLAG_KEY]) return;

  for (const [oldKey, newKey] of RENAMED_KEYS) {
    const stored = await browser.storage.local.get([oldKey, newKey]);
    if (stored[oldKey] === undefined) continue;
    if (stored[newKey] === undefined) {
      await browser.storage.local.set({ [newKey]: stored[oldKey] });
    }
    await browser.storage.local.remove(oldKey);
  }

  await browser.storage.local.set({ [MIGRATION_FLAG_KEY]: true });
}
