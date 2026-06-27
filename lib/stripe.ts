import Stripe from 'stripe';

let stripeClient: Stripe | null = null;

export function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY is not set');
  }

  stripeClient ??= new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: '2026-05-27.dahlia',
    typescript: true,
  });

  return stripeClient;
}

/**
 * Build a Stripe client from an explicit secret key (e.g. the one configured in
 * Super Admin → Stripe Setup), falling back to the env-based singleton when no
 * key is provided. Lets the Bubaly Stripe account be configured at runtime.
 */
export function stripeFromKey(secretKey?: string | null): Stripe {
  const key = secretKey?.trim();
  if (!key) return getStripe();
  return new Stripe(key, { apiVersion: '2026-05-27.dahlia', typescript: true });
}

export const STRIPE_PLANS = {
  basic_monthly: process.env.STRIPE_PRICE_BASIC_MONTHLY ?? process.env.STRIPE_PRICE_FAMILY_MONTHLY ?? '',
  basic_annual: process.env.STRIPE_PRICE_BASIC_ANNUAL ?? process.env.STRIPE_PRICE_FAMILY_ANNUAL ?? '',
  plus_monthly: process.env.STRIPE_PRICE_PLUS_MONTHLY ?? '',
  plus_annual: process.env.STRIPE_PRICE_PLUS_ANNUAL ?? '',
  // Legacy keys — kept so any older client/links keep working. They resolve to
  // the Basic price (the former single "Family" plan is now Family Basic).
  family_monthly: process.env.STRIPE_PRICE_FAMILY_MONTHLY ?? process.env.STRIPE_PRICE_BASIC_MONTHLY ?? '',
  family_annual: process.env.STRIPE_PRICE_FAMILY_ANNUAL ?? process.env.STRIPE_PRICE_BASIC_ANNUAL ?? '',
} as const;

export type StripePlan = keyof typeof STRIPE_PLANS;
