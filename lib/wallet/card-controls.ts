// lib/wallet/card-controls.ts — parent-set card spending controls. PURE + tested.
//
// Backs the per-card controls editor on /wallet/cards. A spend LIMIT + WINDOW is
// enforced by Stripe (mirrored to the card's spending_controls); BLOCKED
// CATEGORIES are enforced both by Stripe and by our real-time authorization
// webhook (decideAuthorization). These helpers validate/normalize the inputs so
// the UI, the server action, and the Stripe mirror all agree — without a network.

/** How often a spend limit resets. Mirrors Stripe spending-limit intervals. */
export type SpendWindow = 'per_authorization' | 'daily' | 'weekly' | 'monthly' | 'all_time';

export const SPEND_WINDOWS: { value: SpendWindow; label: string }[] = [
  { value: 'per_authorization', label: 'Per purchase' },
  { value: 'daily', label: 'Per day' },
  { value: 'weekly', label: 'Per week' },
  { value: 'monthly', label: 'Per month' },
  { value: 'all_time', label: 'Total (all time)' },
];

const WINDOW_SET = new Set<SpendWindow>(SPEND_WINDOWS.map((w) => w.value));

export function isValidSpendWindow(v: unknown): v is SpendWindow {
  return typeof v === 'string' && WINDOW_SET.has(v as SpendWindow);
}

export function normalizeSpendWindow(v: unknown): SpendWindow {
  return isValidSpendWindow(v) ? v : 'per_authorization';
}

/** Limit bounds: $0.01 min (when set), $10,000 max. null = no limit. */
export const MAX_SPEND_LIMIT_CENTS = 1_000_000;

/** Returns a clean integer-cents limit, or null for "no limit". Throws-free. */
export function clampSpendLimitCents(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(Math.round(n), MAX_SPEND_LIMIT_CENTS);
}

/**
 * Curated, kid-safety-focused merchant categories a parent can block. Values are
 * Stripe Issuing merchant-category identifiers (passed straight to Stripe's
 * spending_controls.blocked_categories and checked by our auth webhook).
 */
export const BLOCKABLE_CATEGORIES: { value: string; label: string; emoji: string }[] = [
  { value: 'betting_casino_gambling', label: 'Gambling & casinos', emoji: '🎰' },
  { value: 'drinking_places', label: 'Bars & nightlife', emoji: '🍸' },
  { value: 'liquor_stores', label: 'Liquor stores', emoji: '🍷' },
  { value: 'package_stores_beer_wine_and_liquor', label: 'Beer, wine & liquor', emoji: '🍺' },
  { value: 'cigar_stores_and_stands', label: 'Tobacco & vape', emoji: '🚭' },
  { value: 'dating_escort_services', label: 'Dating services', emoji: '💌' },
  { value: 'massage_parlors', label: 'Massage parlors', emoji: '💆' },
  { value: 'fast_food_restaurants', label: 'Fast food', emoji: '🍔' },
  { value: 'video_amusement_game_supplies', label: 'Game arcades', emoji: '🕹️' },
];

const CATEGORY_SET = new Set(BLOCKABLE_CATEGORIES.map((c) => c.value));

/** Keep only known, deduped category values (order-stable to the catalog). */
export function normalizeBlockedCategories(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const wanted = new Set(values.filter((v): v is string => typeof v === 'string' && CATEGORY_SET.has(v)));
  return BLOCKABLE_CATEGORIES.filter((c) => wanted.has(c.value)).map((c) => c.value);
}

export function categoryLabel(value: string): string {
  return BLOCKABLE_CATEGORIES.find((c) => c.value === value)?.label ?? value;
}
