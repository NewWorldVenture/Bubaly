// lib/marketing/value.ts — the pricing page's value arithmetic and tier copy,
// in one place.
//
// Pure and client-safe (the pricing page is a client component, and so is the
// in-app upgrade modal). Three rules live here and nowhere else:
//
//   1. Per-day framing NEVER understates. A yearly price is divided by 365 and
//      a monthly price by 30, and the result is rounded UP to the next cent —
//      "≈ 28¢ a day" is only honest if the family cannot pay less than that.
//      The figures derive from lib/constants/plans.ts at the call site;
//      nothing here types a dollar amount.
//   2. The REAL "across Bubaly families" card is a cross-family aggregate from
//      public_handled_stats() and is OMITTED — not zeroed, not placeholdered —
//      below HANDLED_PUBLIC_MIN (lib/marketing/format.ts). Hidden is honest,
//      small is honest, invented is not.
//   3. Real, illustrative and the family's own numbers are three different
//      cards. This module shapes each separately so no caller can blend them
//      into one sentence or one number.
//
// The tier copy registries at the bottom are here rather than in
// lib/constants/plans.ts on purpose: PLANS is the admin/billing source of
// truth (slugs, prices, taglines) and is shared with the Stripe spine. What a
// family stops carrying is marketing copy, it is catalogue keys rather than
// English, and both public surfaces that render it (/pricing and the in-app
// upgrade modal) reach it from here.

import { formatHandled, meetsHandledFloor } from '@/lib/marketing/format';

export type BillingPeriod = 'monthly' | 'yearly';

const DAYS_PER_YEAR = 365;
const DAYS_PER_MONTH = 30;

/**
 * Cents per day for a plan price, rounded up so the line never claims a
 * cheaper day than the family actually pays. A non-finite or non-positive
 * price yields 0, which callers render as no line at all.
 */
export function perDayCents(cents: number, period: BillingPeriod): number {
  if (!Number.isFinite(cents) || cents <= 0) return 0;
  const days = period === 'yearly' ? DAYS_PER_YEAR : DAYS_PER_MONTH;
  return Math.ceil(cents / days);
}

/** "28¢" under a dollar, "$1" or "$1.05" from a dollar up. */
export function formatPerDay(cents: number): string {
  const n = Math.max(0, Math.ceil(cents));
  if (n < 100) return `${n}¢`;
  return n % 100 === 0 ? `$${n / 100}` : `$${(n / 100).toFixed(2)}`;
}

export type HandledStatsLike = { handledCompleted: number; handled30d?: number };

/** True only when the recorded complete-or-partial run count reaches the public floor. */
export function shouldShowRealHandled(stats: HandledStatsLike | null | undefined): boolean {
  return meetsHandledFloor(stats?.handledCompleted ?? 0);
}

/**
 * The formatted counts for the REAL card, or null when the card must not
 * render at all. The 30-day figure is held to the same threshold on its own,
 * so a small recent number is hidden rather than printed beside a large total.
 *
 * There is no path through this function that returns a zero: below the floor
 * the answer is null, and the caller renders nothing.
 */
export function realHandledCounts(
  stats: HandledStatsLike | null | undefined,
): { total: string; last30d: string | null } | null {
  if (!shouldShowRealHandled(stats)) return null;
  const total = stats?.handledCompleted ?? 0;
  const recent = stats?.handled30d ?? 0;
  return {
    total: formatHandled(total),
    last30d: meetsHandledFloor(recent) && recent <= total ? formatHandled(recent) : null,
  };
}

// ── Tier copy ───────────────────────────────────────────────────────────────

/** The three tiers the public pricing page and the upgrade modal both speak of. */
export type ValueTier = 'trial' | 'basic' | 'plus';

/** The three rows of the "what stops landing on you" matrix, in render order. */
export type ValueRow = 'youDecide' | 'prepares' | 'handles';

export const VALUE_ROWS: { key: ValueRow; label: string; labelKey: string }[] = [
  { key: 'youDecide', label: 'You still decide', labelKey: 'pricingValue.colYouDecide' },
  { key: 'prepares', label: 'Bubaly prepares', labelKey: 'pricingValue.colPrepares' },
  { key: 'handles', label: 'Bubaly handles', labelKey: 'pricingValue.colHandles' },
];

/** What a family stops carrying on a tier — one line, one catalogue key. */
export type ValueOutcome = { label: string; labelKey: string };

export type ValueTierCopy = {
  key: ValueTier;
  /** English for tests and admin displays; every public surface renders labelKey. */
  label: string;
  labelKey: string;
  /** The outcome-first line that replaces the plan card's old feature tagline. */
  goalKey: string;
  /** The tier-positioning callout under the feature matrix. */
  positioningKey: string;
  cells: Record<ValueRow, string>;
  outcomes: ValueOutcome[];
};

/**
 * One entry per tier. `cells` are the matrix; `outcomes` lead the plan card
 * and the upgrade modal ahead of the feature checklist. Family+ "handles"
 * names the routines a family approves once — meals to list every Sunday,
 * forms to calendar, bill and renewal sweeps — because those are the
 * automations the app actually runs (lib/marketing/automation-runner.ts and
 * the routine spine), not an aspiration.
 */
export const VALUE_TIERS: ValueTierCopy[] = [
  {
    key: 'trial',
    label: '5-Day Free Trial',
    labelKey: 'pricingValue.tierTrial',
    goalKey: 'pricingValue.trialGoal',
    positioningKey: 'pricingValue.positioningTrial',
    cells: {
      youDecide: 'pricingValue.trialYouDecide',
      prepares: 'pricingValue.trialPrepares',
      handles: 'pricingValue.trialHandles',
    },
    outcomes: [
      { label: "The whole family's calendar, lists and messages in one place", labelKey: 'planOutcomes.trialOnePlace' },
      { label: 'Ten assistant requests a month to try the routine work', labelKey: 'planOutcomes.trialTenRequests' },
      { label: 'Full Family Basic for five days, no card', labelKey: 'planOutcomes.trialFiveDays' },
    ],
  },
  {
    key: 'basic',
    label: 'Family Basic',
    labelKey: 'pricingValue.tierBasic',
    goalKey: 'pricingValue.basicGoal',
    positioningKey: 'pricingValue.positioningBasic',
    cells: {
      youDecide: 'pricingValue.basicYouDecide',
      prepares: 'pricingValue.basicPrepares',
      handles: 'pricingValue.basicHandles',
    },
    outcomes: [
      { label: 'Your day prepared before you look: the Daily Brief, meals and the grocery list', labelKey: 'planOutcomes.basicBriefPrepared' },
      { label: 'School flyers and forms turned into events and reminders', labelKey: 'planOutcomes.basicPaperwork' },
      { label: 'Reminders, chores and the kitchen display kept current for everyone', labelKey: 'planOutcomes.basicKitchen' },
    ],
  },
  {
    key: 'plus',
    label: 'Family+',
    labelKey: 'pricingValue.tierPlus',
    goalKey: 'pricingValue.plusGoal',
    positioningKey: 'pricingValue.positioningPlus',
    cells: {
      youDecide: 'pricingValue.plusYouDecide',
      prepares: 'pricingValue.plusPrepares',
      handles: 'pricingValue.plusHandles',
    },
    outcomes: [
      { label: 'Routines you approve once get handled: meals to list, forms to calendar, bill and renewal sweeps', labelKey: 'planOutcomes.plusRoutinesHandled' },
      { label: 'The week prepared for you: clashes, school and sports follow-ups, readiness', labelKey: 'planOutcomes.plusWeekPrepared' },
      { label: 'Only the decisions that need a parent reach you; everything else lands in the ledger', labelKey: 'planOutcomes.plusDecisionsOnly' },
    ],
  },
];

export function valueTier(key: ValueTier): ValueTierCopy {
  const found = VALUE_TIERS.find((tier) => tier.key === key);
  // Every ValueTier has an entry; the fallback keeps callers total rather than
  // rendering `undefined` if one is ever removed.
  return found ?? VALUE_TIERS[0];
}

/**
 * The tier an in-app plan level maps to: 1 → Family Basic, 2 → Family+.
 * Level 0 has no paid pitch, so it falls back to the trial copy.
 */
export function valueTierForLevel(level: number): ValueTierCopy {
  if (level >= 2) return valueTier('plus');
  if (level === 1) return valueTier('basic');
  return valueTier('trial');
}
