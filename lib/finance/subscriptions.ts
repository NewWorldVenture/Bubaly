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

/** Missing or unusable usage data is not evidence that a subscription is unused. */
export function subscriptionUsage(sub: Pick<SubLike, 'last_used'>, now = new Date()): SubscriptionUsage {
  const lastUsed = sub.last_used;
  if (lastUsed === null || lastUsed === undefined || lastUsed === '') return { state: 'unknown' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(lastUsed) || Number(lastUsed.slice(0, 4)) < 1 || Number.isNaN(now.getTime())) {
    return { state: 'invalid' };
  }
  const last = new Date(lastUsed + 'T00:00:00.000Z');
  if (Number.isNaN(last.getTime()) || last.toISOString().slice(0, 10) !== lastUsed) return { state: 'invalid' };
  if (last.getTime() > now.getTime()) return { state: 'future' };
  return { state: 'recorded', lastUsed, daysSinceUse: (now.getTime() - last.getTime()) / 86_400_000 };
}

/** True only for active/trial subscriptions whose recorded use is older than `days`. */
export function isStale(sub: SubLike, days = 60, now = new Date()): boolean {
  if (!COUNTS.has(sub.status)) return false;
  const usage = subscriptionUsage(sub, now);
  return usage.state === 'recorded' && usage.daysSinceUse > days;
}

/** Monthly cost needing a usage review, not confirmed waste or achievable savings. Name retained for callers. */
export function wastedMonthlyCents(subs: SubLike[], days = 60, now = new Date()): number {
  return subs.reduce((sum, s) => (isStale(s, days, now) ? sum + monthlyCostCents(s.cost_cents, s.cadence) : sum), 0);
}
