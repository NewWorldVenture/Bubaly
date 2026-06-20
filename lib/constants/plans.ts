// Subscription plans — single source of truth for plan slugs, display names,
// and prices. Slugs MUST match what the Stripe webhook writes.
//
// Three tiers:
//   free          → FamilyOS Free (no charge)
//   basic / basic_annual  → Family Basic ($9.99/mo or ~$8.33/mo billed yearly)
//   plus  / plus_annual   → Family+ ($24.99/mo or ~$20.83/mo billed yearly)
//
// Legacy: 'family' and 'family_annual' map to basic tier (backward-compat).

export type PlanId = 'free' | 'family' | 'family_annual' | 'basic' | 'basic_annual' | 'plus' | 'plus_annual';

// ── Prices (cents) ─────────────────────────────────────────────────────────
export const BASIC_MONTHLY_CENTS  = 999;   // $9.99/month
export const BASIC_ANNUAL_CENTS   = 9999;  // $99.99/year (~$8.33/mo, save ~17%)
export const PLUS_MONTHLY_CENTS   = 2499;  // $24.99/month
export const PLUS_ANNUAL_CENTS    = 24999; // $249.99/year (~$20.83/mo, save ~17%)

// Legacy alias kept for backward compat
export const FAMILY_MONTHLY_CENTS = BASIC_MONTHLY_CENTS;
export const FAMILY_ANNUAL_CENTS  = BASIC_ANNUAL_CENTS;

// ── Plan level helper ────────────────────────────────────────────────────────
// 0 = free, 1 = basic, 2 = plus
export function planLevel(plan: string | null | undefined): number {
  switch (plan) {
    case 'plus':
    case 'plus_annual':
      return 2;
    case 'basic':
    case 'basic_annual':
    case 'family':         // legacy
    case 'family_annual':  // legacy
      return 1;
    default:
      return 0;
  }
}

export const PLAN_NAMES: Record<string, string> = {
  free: 'FamilyOS Free',
  basic: 'Family Basic',
  basic_annual: 'Family Basic (Annual)',
  family: 'Family Basic',       // legacy
  family_annual: 'Family Basic (Annual)', // legacy
  plus: 'Family+',
  plus_annual: 'Family+ (Annual)',
};

// ── Route → minimum plan level ───────────────────────────────────────────────
// 0 = any signed-in user  |  1 = basic+  |  2 = plus+
export const ROUTE_PLAN_LEVEL: Record<string, number> = {
  // Free routes (everyone)
  '/dashboard':          0,
  '/dashboard/calendar': 0,
  '/dashboard/grocery':  0,
  '/dashboard/todos':    0,
  '/dashboard/recipes':  0,
  '/dashboard/messages': 0,
  '/dashboard/contacts': 0,
  '/dashboard/notes':    0,
  '/dashboard/photos':   0,
  '/dashboard/documents':0,
  '/dashboard/reminders':0,
  '/dashboard/settings': 0,
  '/dashboard/billing':  0,
  // Basic routes
  '/dashboard/chores':        1,
  '/dashboard/meals':         1,
  '/dashboard/school':        1,
  '/dashboard/sports':        1,
  '/dashboard/health':        1,
  '/dashboard/home':          1,
  '/dashboard/medical':       1,
  '/dashboard/dental':        1,
  '/dashboard/goals':         1,
  '/dashboard/notifications': 1,
  '/dashboard/briefing':      1,
  '/dashboard/assistant':     1,
  '/dashboard/inbox':         1,
  '/dashboard/scan':          1,
  // Plus routes
  // (currently the AI enhancements live within existing modules; reserve prefix for future)
};

// ── Legacy Plan type (kept for admin display) ────────────────────────────────
export type Plan = {
  id: PlanId;
  name: string;
  priceMonthly: number;
  tagline: string;
  seats: number | 'Unlimited';
  features: string[];
  featured?: boolean;
};

export const PLANS: Plan[] = [
  {
    id: 'free',
    name: 'FamilyOS Free',
    priceMonthly: 0,
    tagline: 'The default family organizer.',
    seats: 5,
    features: [
      'Shared family calendar',
      'Shopping & to-do lists',
      'Shared recipes',
      'Family messenger',
      'Family contact book',
      'Shared notes & photos',
      '10 AI requests/month',
    ],
  },
  {
    id: 'basic',
    name: 'Family Basic',
    priceMonthly: BASIC_MONTHLY_CENTS,
    tagline: 'The best family organizer on earth.',
    seats: 'Unlimited',
    featured: true,
    features: [
      'Everything in Free',
      'Unlimited family members',
      'Chores, rewards & meal planning',
      'School hub & sports hub',
      'Kitchen Display Mode',
      'Unlimited AI assistant',
      'Smart Imports (flyers, PDFs, photos)',
    ],
  },
  {
    id: 'plus',
    name: 'Family+',
    priceMonthly: PLUS_MONTHLY_CENTS,
    tagline: 'The Family Chief of Staff.',
    seats: 'Unlimited',
    features: [
      'Everything in Family Basic',
      'AI Concierge (ask anything)',
      'AI School & Sports Assistant',
      'Daily & weekly AI Family Briefings',
      'AI Family Command Center',
      'Family Digital Twin',
    ],
  },
];

export const planById = (id: string) => PLANS.find((p) => p.id === id || (id === 'family' && p.id === 'basic') || (id === 'family_annual' && p.id === 'basic'));

/** Monthly-equivalent cents for any plan slug. */
export const planMonthlyCents = (id: string | null): number => {
  switch (id) {
    case 'plus': return PLUS_MONTHLY_CENTS;
    case 'plus_annual': return Math.round(PLUS_ANNUAL_CENTS / 12);
    case 'basic': case 'family': return BASIC_MONTHLY_CENTS;
    case 'basic_annual': case 'family_annual': return Math.round(BASIC_ANNUAL_CENTS / 12);
    default: return 0;
  }
};

/** Human label for any plan slug. */
export const planName = (id: string | null): string =>
  PLAN_NAMES[id ?? ''] ?? (id || 'Free');
