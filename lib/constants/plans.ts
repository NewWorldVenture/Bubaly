// Subscription plans — the SINGLE source of truth for plan slugs, display names,
// and prices. Slugs MUST match what the Stripe webhook writes (see
// app/api/webhooks/stripe/route.ts): 'free', 'family', 'family_annual'.
//
// The product is one paid "Family" plan, billed monthly or annually. Real Stripe
// price IDs live in env (STRIPE_PRICE_FAMILY_MONTHLY / _ANNUAL) and are resolved
// in lib/stripe.ts. Keep prices here in sync with the Stripe dashboard.

export type PlanId = 'free' | 'family' | 'family_annual';

export type Plan = {
  id: PlanId;
  name: string;
  /** Monthly-equivalent price in cents — used for MRR math across admin. */
  priceMonthly: number;
  tagline: string;
  seats: number | 'Unlimited';
  features: string[];
  featured?: boolean;
};

// Authoritative prices (cents). Update alongside the Stripe price objects.
export const FAMILY_MONTHLY_CENTS = 999; // $9.99 / month
export const FAMILY_ANNUAL_CENTS = 9599; // $95.99 / year (~$8.00/mo)

const FAMILY_FEATURES = [
  'Unlimited family members + caregivers',
  'Shared calendar, chores & grocery lists',
  'Meal planning & auto grocery lists',
  'Health, home & document vault',
  'Unlimited AI assistant',
  'Push & email notifications',
  '100 GB document storage',
];

export const PLANS: Plan[] = [
  {
    id: 'free',
    name: 'Free',
    priceMonthly: 0,
    tagline: 'Basic family coordination for up to 2 members.',
    seats: 2,
    features: [
      'Shared calendar & reminders',
      'Chores & grocery lists',
      'Up to 2 members',
    ],
  },
  {
    id: 'family',
    name: 'FamilyOS Family',
    priceMonthly: FAMILY_MONTHLY_CENTS,
    tagline: 'Everything your family needs, billed monthly.',
    seats: 'Unlimited',
    featured: true,
    features: FAMILY_FEATURES,
  },
  {
    id: 'family_annual',
    name: 'FamilyOS Family (Annual)',
    priceMonthly: Math.round(FAMILY_ANNUAL_CENTS / 12),
    tagline: 'The Family plan billed yearly — save ~20%.',
    seats: 'Unlimited',
    features: FAMILY_FEATURES,
  },
];

export const planById = (id: string) => PLANS.find((p) => p.id === id);

/** Monthly-equivalent cents for any plan slug the webhook may write. */
export const planMonthlyCents = (id: string | null): number =>
  planById(id ?? '')?.priceMonthly ?? 0;

/** Human label for any plan slug, falling back to the raw slug. */
export const planName = (id: string | null): string =>
  planById(id ?? '')?.name ?? (id || 'Free');
