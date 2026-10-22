// lib/finance/subscriptions.ts — pure helpers for Subscription Tracking.
// Cadence-normalised cost math, spend rollups and recorded-usage review.
// No Supabase/React so it's deterministically testable.

export const CADENCES = ['weekly', 'monthly', 'quarterly', 'yearly'] as const;
export type Cadence = (typeof CADENCES)[number];

export const SUB_STATUSES = ['active', 'trial', 'paused', 'canceled'] as const;

const PER_YEAR: Record<Cadence, number> = { weekly: 52, monthly: 12, quarterly: 4, yearly: 1 };

export function annualCostCents(costCents: number, cadence: string): number {
  const per = PER_YEAR[(cadence as Cadence)] ?? 12;
  return Math.round(costCents * per);
}

export function monthlyCostCents(costCents: number, cadence: string): number {
  return Math.round(annualCostCents(costCents, cadence) / 12);
}

export type SubLike = {
  cost_cents: number;
  cadence: string;
  status: string;
  last_used?: string | null;
};

/** Active (or trialing) subscriptions only count toward live spend. */
const COUNTS = new Set(['active', 'trial']);

export function summarizeSubscriptions(subs: SubLike[]) {
  let monthly = 0, annual = 0, active = 0;
  for (const s of subs) {
    if (!COUNTS.has(s.status)) continue;
    active++;
    monthly += monthlyCostCents(s.cost_cents, s.cadence);
    annual += annualCostCents(s.cost_cents, s.cadence);
  }
  return { active, monthlyCents: monthly, annualCents: annual };
}

export type SubscriptionUsage =
  | { state: 'unknown' | 'invalid' | 'future' }
  | { state: 'recorded'; lastUsed: string; daysSinceUse: number };

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Missing or unusable usage data is not evidence that a subscription is unused.
 *
 * `now` is either an instant or — what a caller with a family should pass — the
 * FAMILY's day key (`YYYY-MM-DD`). `last_used` is a DATE on the family's wall
 * ("Mark used today" writes the family's day), so against a day key it is
 * compared as a day: 'future' only when it is later than the family's today,
 * and days-since-use is a whole calendar-day difference. Against an instant it
 * was compared with Greenwich's midnight, so a Sydney family that tapped "Mark
 * used today" before 11am was told the date was in the future.
 */
export function subscriptionUsage(sub: Pick<SubLike, 'last_used'>, now: Date | string = new Date()): SubscriptionUsage {
  const lastUsed = sub.last_used;
  if (lastUsed === null || lastUsed === undefined || lastUsed === '') return { state: 'unknown' };
  const nowMs = typeof now === 'string'
    ? (DAY_KEY.test(now) ? Date.parse(`${now}T00:00:00.000Z`) : Number.NaN)
    : now.getTime();
  if (!DAY_KEY.test(lastUsed) || Number(lastUsed.slice(0, 4)) < 1 || Number.isNaN(nowMs)) {
    return { state: 'invalid' };
  }
  const last = new Date(lastUsed + 'T00:00:00.000Z');
  if (Number.isNaN(last.getTime()) || last.toISOString().slice(0, 10) !== lastUsed) return { state: 'invalid' };
  if (last.getTime() > nowMs) return { state: 'future' };
  return { state: 'recorded', lastUsed, daysSinceUse: (nowMs - last.getTime()) / 86_400_000 };
}

/** True only for active/trial subscriptions whose recorded use is older than `days`. */
export function isStale(sub: SubLike, days = 60, now: Date | string = new Date()): boolean {
  if (!COUNTS.has(sub.status)) return false;
  const usage = subscriptionUsage(sub, now);
  return usage.state === 'recorded' && usage.daysSinceUse > days;
}

/** Monthly cost needing a usage review, not confirmed waste or achievable savings. Name retained for callers. */
export function wastedMonthlyCents(subs: SubLike[], days = 60, now: Date | string = new Date()): number {
  return subs.reduce((sum, s) => (isStale(s, days, now) ? sum + monthlyCostCents(s.cost_cents, s.cadence) : sum), 0);
}
