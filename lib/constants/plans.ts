// Subscription plans — single source of truth for plan slugs, display names,
// and prices. Slugs MUST match what the Stripe webhook writes.
//
// Three tiers:
//   free          → Bubaly Free (no charge)
//   basic / basic_annual  → Family Basic ($12.04/mo or $9.99/mo billed yearly)
//   plus  / plus_annual   → Family+ ($30.11/mo or $24.99/mo billed yearly)
//
// Legacy: 'family' and 'family_annual' map to basic tier (backward-compat).

import familyPrices from './family-prices.json';
import { FEATURE_CATALOG } from './feature-catalog';

export type PlanId = 'free' | 'family' | 'family_annual' | 'basic' | 'basic_annual' | 'plus' | 'plus_annual';

// ── Prices (cents) ─────────────────────────────────────────────────────────
// Annual totals keep the requested monthly equivalents exact. Monthly billing
// reverses the advertised 17% saving and rounds to cents (savings round to 17%).
// The same catalogue records the verified current and previous Stripe prices.
export const BASIC_MONTHLY_CENTS  = familyPrices.basic.monthlyCents;
export const BASIC_ANNUAL_CENTS   = familyPrices.basic.annualCents;
export const PLUS_MONTHLY_CENTS   = familyPrices.plus.monthlyCents;
export const PLUS_ANNUAL_CENTS    = familyPrices.plus.annualCents;

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

/**
 * Minimum plan level for a family's own @bubaly.com address.
 *
 * The gate used to be a bare `requirePlanLevel(2)` on the Contact Center screen
 * and nowhere else, so the SCREEN was Family+ while the pipeline behind it was
 * open to everyone: provisioning ran for every tier at onboarding, and the
 * inbound webhook had no plan check at all. A Free family therefore had a
 * working address that received mail, ran the AI concierge over it, and
 * auto-replied as the family — they simply could not see the inbox.
 *
 * All three now read this constant, so the entitlement is stated once. Moving
 * the feature to another tier is a change to this line, not a hunt through
 * three files.
 */
export const FAMILY_EMAIL_MIN_PLAN_LEVEL = 2;

// Short tier labels by plan level (0/1/2) — used in the account widget etc.
export const TIER_LABEL_BY_LEVEL = ['Free Tier', 'Basic Tier', 'Plus Tier'] as const;
export const tierLabelForLevel = (level: number): string =>
  TIER_LABEL_BY_LEVEL[level] ?? 'Free Tier';

export const PLAN_NAMES: Record<string, string> = {
  free: 'Bubaly Free',
  basic: 'Family Basic',
  basic_annual: 'Family Basic (Annual)',
  family: 'Family Basic',       // legacy
  family_annual: 'Family Basic (Annual)', // legacy
  plus: 'Family+',
  plus_annual: 'Family+ (Annual)',
};

// ── Route → minimum plan level ───────────────────────────────────────────────
// 0 = any signed-in user  |  1 = basic+  |  2 = plus+
//
// DOCUMENTATION ONLY. Nothing reads this map. Entitlement is enforced from
// `FEATURE_CATALOG` (catalog default, overridden per-deployment by the admin's
// Tier & Features settings) through `requireFeature` and
// `resolveFeatureEntitlement`.
//
// It used to be written out by hand, and on 2026-09-13 it disagreed with the
// enforced tiers on 19 of the 55 routes it shared with them — a third of the
// table — while three other documents cited it as fact. So the catalog routes
// are now DERIVED, and can no longer drift from what is enforced. Only routes
// that are not catalog features at all are still stated here, because the
// catalog has nothing to say about them.
const NON_FEATURE_ROUTE_LEVEL: Record<string, number> = {
  '/dashboard':             0,
  '/dashboard/settings':    0,
  '/dashboard/billing':     0,
  '/dashboard/trust':       0,  // Trust & Permissions is foundational safety — free for all
  '/dashboard/relationship': 0, // Relationship Helper (dates, gift ideas, AI nudges)
};

export const ROUTE_PLAN_LEVEL: Record<string, number> = {
  ...NON_FEATURE_ROUTE_LEVEL,
  ...Object.fromEntries(
    FEATURE_CATALOG.flatMap((f) => {
      // An 'off' feature is unavailable at every tier, so it has no minimum
      // plan level to document — listing it as 0 would read as "free".
      if (!f.href || f.defaultTier === 'off') return [];
      const level = f.defaultTier === 'plus' ? 2 : f.defaultTier === 'basic' ? 1 : 0;
      return [[f.href, level] as const];
    })
      // Two features can share an href; the more permissive tier wins, exactly
      // as `tiersByHref` resolves it.
      .reduce((out, [href, level]) => {
        const seen = out.get(href);
        return out.set(href, seen === undefined ? level : Math.min(seen, level));
      }, new Map<string, number>()),
  ),
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
    name: 'Bubaly Free',
    priceMonthly: 0,
    tagline: 'The default family organizer.',
    seats: 5,
    features: [
      'Shared family calendar',
      'Shopping & to-do lists',
      'Chores & meal planning',
      'Recipes & pantry',
      'Family messenger & contacts',
      'Notes, photos & journal',
      'Documents & medical records',
      'Family map & member profiles',
      'School, homework & timetables',
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
      'Unlimited AI assistant & concierge',
      'Smart Kitchen & Smart Imports',
      'Behavior & screen-time tools',
      'Health, medications & dental',
      'Trips, rides & expense splitting',
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
      'Daily & weekly AI Family Briefings',
      'AI Family Command Center',
      'Family Missions & rewards',
      'AI School & Sports Assistant',
      'Emergency Hub & Family Digital Twin',
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
