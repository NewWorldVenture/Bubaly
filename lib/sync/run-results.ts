// One "Sync now" can cover several accounts of a provider — a person may
// connect a personal and a work calendar, which sync_accounts stores as two rows
// (unique on user_id, provider, external_id). The controls render one result, so
// the per-account results are summed; any account's error is kept, because an
// account that failed must not disappear behind one that worked.

export type SyncRunResult = { imported: number; exported: number; skipped: number; conflicts: number; error?: string };

export function combineRunResults(results: readonly SyncRunResult[]): SyncRunResult {
  const combined: SyncRunResult = { imported: 0, exported: 0, skipped: 0, conflicts: 0 };
  const errors: string[] = [];
  for (const r of results) {
    combined.imported += r.imported;
    combined.exported += r.exported;
    combined.skipped += r.skipped;
    combined.conflicts += r.conflicts;
    if (r.error && !errors.includes(r.error)) errors.push(r.error);
  }
  if (errors.length) combined.error = errors.join(' ');
  return combined;
}
