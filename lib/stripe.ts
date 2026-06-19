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

export const STRIPE_PLANS = {
  family_monthly: process.env.STRIPE_PRICE_FAMILY_MONTHLY ?? '',
  family_annual: process.env.STRIPE_PRICE_FAMILY_ANNUAL ?? '',
} as const;

export type StripePlan = keyof typeof STRIPE_PLANS;
