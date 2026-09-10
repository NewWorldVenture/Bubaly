// lib/billing/plans.ts — pure plan/interval logic for self-serve billing.
// Maps between the app's plan slugs (stored on subscriptions.plan), the
// purchasable Stripe plan keys, and tier level + interval — and classifies a
// requested change as an upgrade / downgrade / interval switch. No Stripe/DB.
import {
  BASIC_MONTHLY_CENTS, BASIC_ANNUAL_CENTS, PLUS_MONTHLY_CENTS, PLUS_ANNUAL_CENTS, planLevel,
} from '@/lib/constants/plans';

export type BillingInterval = 'monthly' | 'annual';
/** The four purchasable plans (also the Stripe price keys in lib/stripe.ts). */
export type StripePlan = 'basic_monthly' | 'basic_annual' | 'plus_monthly' | 'plus_annual';

/** Only a live provider subscription can be changed or resumed in place. */
export function canChangeSubscriptionInPlace<T extends { status: string; provider_ref: string | null }>(subscription: T | null | undefined): subscription is T & { provider_ref: string } {
  return !!subscription?.provider_ref && ['active', 'trialing', 'past_due'].includes(subscription.status);
}

export const STRIPE_PLAN_KEYS: StripePlan[] = ['basic_monthly', 'basic_annual', 'plus_monthly', 'plus_annual'];

export type PlanMeta = {
  plan: StripePlan;
  level: 1 | 2;              // 1 = Basic, 2 = Plus
  interval: BillingInterval;
  monthlyCents: number;      // per-month equivalent (annual ÷ 12)
  totalCents: number;        // charged amount per billing period
  label: string;
};

export const PLAN_META: Record<StripePlan, PlanMeta> = {
  basic_monthly: { plan: 'basic_monthly', level: 1, interval: 'monthly', monthlyCents: BASIC_MONTHLY_CENTS, totalCents: BASIC_MONTHLY_CENTS, label: 'Family Basic · Monthly' },
  basic_annual:  { plan: 'basic_annual',  level: 1, interval: 'annual',  monthlyCents: Math.round(BASIC_ANNUAL_CENTS / 12), totalCents: BASIC_ANNUAL_CENTS, label: 'Family Basic · Annual' },
  plus_monthly:  { plan: 'plus_monthly',  level: 2, interval: 'monthly', monthlyCents: PLUS_MONTHLY_CENTS, totalCents: PLUS_MONTHLY_CENTS, label: 'Family+ · Monthly' },
  plus_annual:   { plan: 'plus_annual',   level: 2, interval: 'annual',  monthlyCents: Math.round(PLUS_ANNUAL_CENTS / 12), totalCents: PLUS_ANNUAL_CENTS, label: 'Family+ · Annual' },
};

export function isStripePlan(v: string): v is StripePlan {
  return (STRIPE_PLAN_KEYS as string[]).includes(v);
}

/** The Stripe plan key for a (tier level, interval) pair. */
export function stripePlanFor(level: 1 | 2, interval: BillingInterval): StripePlan {
  const tier = level === 2 ? 'plus' : 'basic';
  return `${tier}_${interval === 'annual' ? 'annual' : 'monthly'}` as StripePlan;
}

/** Interval implied by a stored subscription plan slug (annual slugs end _annual). */
export function intervalOfSlug(slug: string | null | undefined): BillingInterval {
  return (slug ?? '').endsWith('_annual') ? 'annual' : 'monthly';
}

/** The current plan as a Stripe plan key, or null when on Free / no plan. */
export function slugToStripePlan(slug: string | null | undefined): StripePlan | null {
  const level = planLevel(slug ?? null);
  if (level === 0) return null;
  return stripePlanFor(level === 2 ? 2 : 1, intervalOfSlug(slug));
}

export type PlanChange = 'current' | 'upgrade' | 'downgrade' | 'switch_interval' | 'new';

/**
 * Classify moving from the family's current plan slug to a target Stripe plan:
 *  - 'new'             — currently Free (no paid sub) → first purchase
 *  - 'current'         — already on exactly this plan + interval
 *  - 'upgrade'         — higher tier (Basic→Plus)
 *  - 'downgrade'       — lower tier (Plus→Basic)
 *  - 'switch_interval' — same tier, monthly↔annual
 */
export function classifyChange(currentSlug: string | null | undefined, target: StripePlan): PlanChange {
  const curLevel = planLevel(currentSlug ?? null);
  if (curLevel === 0) return 'new';
  const targetLevel = PLAN_META[target].level;
  if (targetLevel > curLevel) return 'upgrade';
  if (targetLevel < curLevel) return 'downgrade';
  // Same tier → interval switch or no-op.
  return intervalOfSlug(currentSlug) === PLAN_META[target].interval ? 'current' : 'switch_interval';
}

export const CHANGE_LABELS: Record<PlanChange, string> = {
  current: 'Current plan',
  upgrade: 'Upgrade',
  downgrade: 'Downgrade',
  switch_interval: 'Switch billing',
  new: 'Choose',
};

/** Percent saved by paying annually for a tier (e.g. 17). */
export function annualSavingsPct(level: 1 | 2): number {
  const m = level === 2 ? PLUS_MONTHLY_CENTS : BASIC_MONTHLY_CENTS;
  const a = level === 2 ? PLUS_ANNUAL_CENTS : BASIC_ANNUAL_CENTS;
  return Math.round((1 - a / (m * 12)) * 100);
}
