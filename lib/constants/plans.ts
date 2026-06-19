// Subscription plans. priceId maps to your Stripe price; wire in the billing webhook.
export type Plan = {
  id: 'free' | 'family' | 'family_plus';
  name: string;
  priceMonthly: number; // cents
  tagline: string;
  seats: number | 'Unlimited';
  features: string[];
  featured?: boolean;
  priceId?: string; // Stripe price id (set via env in production)
};

export const PLANS: Plan[] = [
  {
    id: 'free',
    name: 'Starter',
    priceMonthly: 0,
    tagline: 'For families just getting organized.',
    seats: 4,
    features: [
      'Shared calendar & reminders',
      'Chores & grocery lists',
      'Up to 4 members',
      '50 AI assistant messages / month',
      '1 GB document storage',
    ],
  },
  {
    id: 'family',
    name: 'Family',
    priceMonthly: 900,
    tagline: 'Everything a busy household needs.',
    seats: 8,
    featured: true,
    priceId: process.env.NEXT_PUBLIC_STRIPE_PRICE_FAMILY,
    features: [
      'Everything in Starter',
      'Up to 8 members + caregivers',
      'Meal planning & auto grocery lists',
      'Health, home & document vault',
      'Unlimited AI assistant',
      'Push & email notifications',
      '20 GB document storage',
    ],
  },
  {
    id: 'family_plus',
    name: 'Family Plus',
    priceMonthly: 1900,
    tagline: 'For large or multi-generational homes.',
    seats: 'Unlimited',
    priceId: process.env.NEXT_PUBLIC_STRIPE_PRICE_FAMILY_PLUS,
    features: [
      'Everything in Family',
      'Unlimited members',
      'Priority AI & faster models',
      'Advanced audit log & exports',
      '100 GB document storage',
      'Priority support',
    ],
  },
];

export const planById = (id: string) => PLANS.find((p) => p.id === id);
