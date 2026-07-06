// Model-refresh staleness policy (pure, unit-tested, DB-free).
//
// The twin graph + prep plans should stay continuously updated without anyone
// pressing a button. A cron sweeps families on a schedule; this decides whether a
// given family is due for a refresh (so we skip ones refreshed moments ago) and
// summarizes a sweep. Deterministic => testable.

export const DEFAULT_TTL_MINUTES = 6 * 60; // twice-daily cron → refresh at most every 6h

/** True when `lastRefreshedAt` is missing or older than `ttlMinutes` before `now`. */
export function shouldRefresh(
  lastRefreshedAt: string | Date | null | undefined,
  now: Date = new Date(),
  ttlMinutes: number = DEFAULT_TTL_MINUTES,
): boolean {
  if (!lastRefreshedAt) return true;
  const last = lastRefreshedAt instanceof Date ? lastRefreshedAt : new Date(lastRefreshedAt);
  if (Number.isNaN(last.getTime())) return true;
  const ageMinutes = (now.getTime() - last.getTime()) / 60_000;
  return ageMinutes >= ttlMinutes;
}

export type RefreshOutcome = { familyId: string; ok: boolean; entities?: number; edges?: number; plans?: number; skipped?: boolean; error?: string };

export type SweepSummary = { families: number; refreshed: number; skipped: number; failures: number };

/** Roll per-family outcomes into a sweep summary. */
export function summarizeSweep(outcomes: RefreshOutcome[]): SweepSummary {
  return {
    families: outcomes.length,
    refreshed: outcomes.filter((o) => o.ok && !o.skipped).length,
    skipped: outcomes.filter((o) => o.skipped).length,
    failures: outcomes.filter((o) => !o.ok).length,
  };
}
