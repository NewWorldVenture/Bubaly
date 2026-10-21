// lib/wallet/allowance.ts — pure date math for allowance scheduling. The cron
// runner and the rule editor share these so "next run" is computed identically.

export type Cadence = 'weekly' | 'biweekly' | 'monthly';

const DAY_MS = 86_400_000;

function isoDay(s: string): string {
  return s.slice(0, 10);
}

/** Advance a YYYY-MM-DD date by one cadence period, returning YYYY-MM-DD. */
export function nextRunDate(fromIso: string, cadence: Cadence): string {
  const [y, m, d] = isoDay(fromIso).split('-').map(Number);
  if (cadence === 'monthly') {
    // same day next month, clamped to month length
    const target = new Date(Date.UTC(y, m, 1)); // first of next month (m is 1-based → index m = next month)
    const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    target.setUTCDate(Math.min(d, lastDay));
    return target.toISOString().slice(0, 10);
  }
  const step = cadence === 'weekly' ? 7 : 14;
  return new Date(Date.UTC(y, m - 1, d) + step * DAY_MS).toISOString().slice(0, 10);
}

/** Is an allowance rule due to run on/before `today`? */
export function isAllowanceDue(nextRunOn: string | null, today: string): boolean {
  if (!nextRunOn) return false;
  return isoDay(nextRunOn) <= isoDay(today);
}

/**
 * Catch up a missed schedule: roll `nextRunOn` forward until it is in the future
 * relative to `today`, counting how many periods were missed (capped so a long
 * gap can't mint a huge backlog). Returns the next future run date + run count.
 */
export function rollForward(nextRunOn: string, cadence: Cadence, today: string, maxRuns = 1): { runs: number; next: string } {
  let cursor = isoDay(nextRunOn);
  let runs = 0;
  while (cursor <= isoDay(today) && runs < maxRuns) {
    runs += 1;
    cursor = nextRunDate(cursor, cadence);
  }
  // if still in the past beyond the cap, jump to the next future date without paying
  while (cursor <= isoDay(today)) cursor = nextRunDate(cursor, cadence);
  return { runs, next: cursor };
}

/**
 * The ledger key of one allowance PAYMENT: the rule and the day it is paid for.
 *
 * Every credit used to carry `related_id = rule.id`, so the ledger could not
 * tell week one from week two and no key could ever refuse a second credit of
 * the same occurrence — which is exactly what a run needs when an insert's
 * answer is lost (the insert committed, the connection dropped) and the
 * schedule is rolled back and paid again. Keyed per occurrence, a run can ask
 * the ledger whether this payment landed, and the owner's partial unique index
 * on (family_id, related_type, related_id, bucket_id) can refuse the repeat.
 */
export function allowanceOccurrenceKey(ruleId: string, runDate: string): string {
  return `${ruleId}:${runDate}`;
}

export type DueRule = { isActive: boolean; nextRunOn: string | null; amountCents: number };

/** Summary of allowance rules that are due to pay (next_run_on ≤ today), used to
 *  drive the parent "Run due now" button. Only active, dated, positive rules count. */
export function dueAllowances(rules: DueRule[], today: string): { count: number; totalCents: number } {
  const t = isoDay(today);
  let count = 0;
  let totalCents = 0;
  for (const r of rules) {
    if (!r.isActive || !r.nextRunOn || r.amountCents <= 0) continue;
    if (isoDay(r.nextRunOn) <= t) { count += 1; totalCents += r.amountCents; }
  }
  return { count, totalCents };
}
