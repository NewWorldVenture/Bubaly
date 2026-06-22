// lib/onboarding/family.ts — pure helpers for the "About your family" onboarding
// step. Option catalogs + small deterministic transforms, unit-tested here; the
// server action does the DB write.

export type GoalOption = { value: string; label: string; icon: string };

/** What families want to use Bubaly for. Drives later personalization. */
export const FAMILY_GOALS: GoalOption[] = [
  { value: 'chores', label: 'Chores & allowance', icon: '🧹' },
  { value: 'calendar', label: 'Shared calendar', icon: '📅' },
  { value: 'meals', label: 'Meal planning', icon: '🍽️' },
  { value: 'groceries', label: 'Groceries & lists', icon: '🛒' },
  { value: 'budget', label: 'Family budget', icon: '💵' },
  { value: 'health', label: 'Health & medications', icon: '💊' },
  { value: 'school', label: 'School & homework', icon: '🎒' },
  { value: 'activities', label: 'Sports & activities', icon: '⚽' },
];
const GOAL_VALUES = new Set(FAMILY_GOALS.map((g) => g.value));

export type ReferralOption = { value: string; label: string };

/** How they heard about Bubaly (attribution for the marketing platform). */
export const REFERRAL_SOURCES: ReferralOption[] = [
  { value: 'search', label: 'Search engine (Google, etc.)' },
  { value: 'friend_family', label: 'Friend or family' },
  { value: 'social', label: 'Social media' },
  { value: 'app_store', label: 'App Store / Play Store' },
  { value: 'blog', label: 'Blog or article' },
  { value: 'ad', label: 'An ad' },
  { value: 'podcast', label: 'Podcast' },
  { value: 'other', label: 'Other' },
];
const REFERRAL_VALUES = new Set(REFERRAL_SOURCES.map((r) => r.value));

/** Keep only recognised goal values, de-duplicated and order-stable. */
export function cleanGoals(input: readonly string[] | null | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const g of input ?? []) {
    if (GOAL_VALUES.has(g) && !seen.has(g)) { seen.add(g); out.push(g); }
  }
  return out;
}

/** Validate a referral source, returning null for anything unrecognised. */
export function cleanReferralSource(value: string | null | undefined): string | null {
  return value && REFERRAL_VALUES.has(value) ? value : null;
}

/** Parse a free-text list of child ages ("8, 11 and 14") into clamped ints. */
export function parseChildAges(input: string | null | undefined): number[] {
  if (!input) return [];
  return (input.match(/\d{1,2}/g) ?? [])
    .map((n) => Math.min(21, Math.max(0, parseInt(n, 10))))
    .filter((n) => Number.isFinite(n))
    .slice(0, 20);
}

/** A short human summary of the household, e.g. "2 adults · 3 kids". */
export function householdSummary(adults: number, children: number): string {
  const a = Math.max(0, adults);
  const c = Math.max(0, children);
  const parts = [`${a} adult${a === 1 ? '' : 's'}`];
  if (c > 0) parts.push(`${c} kid${c === 1 ? '' : 's'}`);
  return parts.join(' · ');
}
