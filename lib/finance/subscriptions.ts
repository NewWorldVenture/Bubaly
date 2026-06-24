// lib/finance/subscriptions.ts — pure helpers for Subscription Tracking.
// Cadence-normalised cost math, spend rollups and stale/unused detection.
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

/** True when an active subscription hasn't been used in `days` (or never). */
export function isStale(sub: SubLike, days = 60, now = new Date()): boolean {
  if (!COUNTS.has(sub.status)) return false;
  if (!sub.last_used) return true;
  const last = new Date(sub.last_used + 'T00:00:00.000Z').getTime();
  return now.getTime() - last > days * 86_400_000;
}

/** Potential monthly savings if every stale subscription were cancelled. */
export function wastedMonthlyCents(subs: SubLike[], days = 60, now = new Date()): number {
  return subs.reduce((sum, s) => (isStale(s, days, now) ? sum + monthlyCostCents(s.cost_cents, s.cadence) : sum), 0);
}
