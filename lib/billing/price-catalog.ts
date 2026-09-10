import type Stripe from 'stripe';
import FAMILY_PRICES from '@/lib/constants/family-prices.json';

export type CanonicalStripePlan = 'basic_monthly' | 'basic_annual' | 'plus_monthly' | 'plus_annual';
export type StripePlanKey = CanonicalStripePlan | 'family_monthly' | 'family_annual';
export type PaidPlanSlug = 'basic' | 'basic_annual' | 'plus' | 'plus_annual';

const PLAN_PRICES = {
  basic_monthly: { amount: FAMILY_PRICES.basic.monthlyCents, interval: 'month', slug: 'basic' },
  basic_annual: { amount: FAMILY_PRICES.basic.annualCents, interval: 'year', slug: 'basic_annual' },
  plus_monthly: { amount: FAMILY_PRICES.plus.monthlyCents, interval: 'month', slug: 'plus' },
  plus_annual: { amount: FAMILY_PRICES.plus.annualCents, interval: 'year', slug: 'plus_annual' },
} as const;

/** Validate untrusted request values before using a plan as an object key. */
export function isStripePlanKey(value: unknown): value is StripePlanKey {
  return value === 'basic_monthly' || value === 'basic_annual' || value === 'plus_monthly'
    || value === 'plus_annual' || value === 'family_monthly' || value === 'family_annual';
}

export function canonicalStripePlan(plan: StripePlanKey): CanonicalStripePlan {
  if (plan === 'family_monthly') return 'basic_monthly';
  if (plan === 'family_annual') return 'basic_annual';
  return plan;
}

/** Only replace this plan's known previous IDs; custom/test configuration stays intact. */
export function currentStripePriceId(plan: StripePlanKey, configured: string): string {
  const entry = FAMILY_PRICES.stripePrices[canonicalStripePlan(plan)];
  return entry.previousIds.includes(configured) ? entry.id : configured;
}

/** Historic prices remain entitled when existing subscriptions renew. */
export function catalogPlanForPrice(priceId: unknown): PaidPlanSlug | null {
  if (typeof priceId !== 'string' || !priceId) return null;
  for (const plan of Object.keys(PLAN_PRICES) as CanonicalStripePlan[]) {
    const entry = FAMILY_PRICES.stripePrices[plan];
    if (priceId === entry.id || entry.previousIds.includes(priceId)) return PLAN_PRICES[plan].slug;
  }
  return null;
}

/** Confirm the amount Stripe will charge before creating or changing billing. */
export async function verifyStripePlanPrice(
  stripe: Pick<Stripe, 'prices'>,
  plan: StripePlanKey,
  priceId: string,
): Promise<boolean> {
  try {
    const price = await stripe.prices.retrieve(priceId);
    const expected = PLAN_PRICES[canonicalStripePlan(plan)];
    return price.id === priceId && price.active === true && price.type === 'recurring'
      && price.currency === FAMILY_PRICES.currency && price.unit_amount === expected.amount
      && (price.unit_amount_decimal == null || Number(price.unit_amount_decimal) === expected.amount)
      && price.billing_scheme === 'per_unit' && price.transform_quantity == null && price.custom_unit_amount == null
      && price.recurring?.interval === expected.interval && price.recurring.interval_count === 1
      && price.recurring.usage_type === 'licensed';
  } catch {
    // A failed provider read cannot authorize a paid mutation.
    return false;
  }
}
