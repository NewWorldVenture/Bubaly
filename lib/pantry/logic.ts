// lib/pantry/logic.ts — pure helpers for Pantry / Inventory / Expiration tracking.
// No I/O here so it's fully unit-testable; the module + API call into it.
//
// ── The unit is a DAY KEY, not an instant ───────────────────────────────────
//
// These took `now: number = Date.now()` and computed "today" with
// `setHours(0, 0, 0, 0)` — the HOST's midnight. On a UTC server that is 5pm in
// California, so for the last seven hours of every day:
//
//   food expiring TOMORROW was labelled "Expires today";
//   food expiring TODAY was labelled "Expired yesterday";
//   and `expiringSoon` handed the AI chef and the meal planner a window shifted
//   a day, so they urged cooking things that were not urgent and wrote off food
//   that was still good.
//
// Taking a `todayKey` instead of an instant removes the zone from this module
// entirely: both dates are parsed as UTC midnights, so the subtraction is exact
// whole days and there is no host clock left to be wrong about. Each caller
// answers "which day is it" where it has the family's zone to answer with — and
// that includes the CLIENT ones, because "expires today" has to mean the same
// day for the parent on a server-rendered page and the child on a
// browser-rendered one.
//
// No default. `= Date.now()` is exactly what made this invisible: every call
// site read as though it were already correct.

export type PantryLocation = 'pantry' | 'fridge' | 'freezer' | 'counter' | 'garage' | 'other';

export const PANTRY_LOCATIONS: { id: PantryLocation; label: string; emoji: string }[] = [
  { id: 'pantry', label: 'Pantry', emoji: '🫙' },
  { id: 'fridge', label: 'Fridge', emoji: '🧊' },
  { id: 'freezer', label: 'Freezer', emoji: '❄️' },
  { id: 'counter', label: 'Counter', emoji: '🍌' },
  { id: 'garage', label: 'Garage', emoji: '📦' },
  { id: 'other', label: 'Other', emoji: '🏠' },
];

export function locationMeta(id: string) {
  return PANTRY_LOCATIONS.find((l) => l.id === id) ?? PANTRY_LOCATIONS[PANTRY_LOCATIONS.length - 1];
}

export type ExpiryTone = 'danger' | 'warning' | 'caution' | 'success' | 'neutral';

/**
 * Whole days from `todayKey` until the date (negative = already past).
 *
 * Both are `YYYY-MM-DD` and both are parsed as UTC midnight, which is not a
 * claim that anyone is in UTC — it is how two calendar days are subtracted
 * without a zone entering into it at all.
 */
export function daysUntil(dateStr: string | null | undefined, todayKey: string): number | null {
  if (!dateStr) return null;
  const t = Date.parse(`${dateStr.slice(0, 10)}T00:00:00Z`);
  const today = Date.parse(`${todayKey.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(t) || !Number.isFinite(today)) return null;
  return Math.round((t - today) / 86400000);
}

/**
 * Expiration status for a best-by date. Tiers, soonest first:
 *   expired (<0) · today (0) · soon (≤3) · this week (≤7) · ok (>7) · none.
 */
export function expiryStatus(dateStr: string | null | undefined, todayKey: string): {
  tone: ExpiryTone; label: string; days: number | null; expired: boolean;
} {
  const days = daysUntil(dateStr, todayKey);
  if (days === null) return { tone: 'neutral', label: 'No date', days: null, expired: false };
  if (days < 0) return { tone: 'danger', label: days === -1 ? 'Expired yesterday' : `Expired ${-days}d ago`, days, expired: true };
  if (days === 0) return { tone: 'danger', label: 'Expires today', days, expired: false };
  if (days <= 3) return { tone: 'warning', label: days === 1 ? 'Expires tomorrow' : `Expires in ${days}d`, days, expired: false };
  if (days <= 7) return { tone: 'caution', label: `Expires in ${days}d`, days, expired: false };
  return { tone: 'success', label: `Expires in ${days}d`, days, expired: false };
}

export interface PantryLike {
  id?: string;
  name?: string;
  quantity?: number | null;
  low_threshold?: number | null;
  expires_at?: string | null;
  is_staple?: boolean | null;
  location?: string | null;
  category?: string | null;
}

/** A staple or threshold-tracked item is "low" when its quantity has fallen to
 *  or below the restock threshold (default 1 for staples without a threshold). */
export function isLowStock(item: PantryLike): boolean {
  const qty = item.quantity ?? 0;
  if (item.low_threshold != null) return qty <= item.low_threshold;
  if (item.is_staple) return qty <= 1;
  return false;
}

/** Items expiring within `withinDays` (inclusive), expired items first, soonest first. */
export function expiringSoon<T extends PantryLike>(items: T[], withinDays: number, todayKey: string): T[] {
  return items
    .filter((i) => {
      const d = daysUntil(i.expires_at, todayKey);
      return d !== null && d <= withinDays;
    })
    .sort((a, b) => (daysUntil(a.expires_at, todayKey) ?? 0) - (daysUntil(b.expires_at, todayKey) ?? 0));
}

/** Everything that's low on stock (for the restock / grocery-suggestion list). */
export function lowStockItems<T extends PantryLike>(items: T[]): T[] {
  return items.filter(isLowStock);
}

/** Group items by location in canonical order; empty locations are dropped. */
export function groupByLocation<T extends PantryLike>(items: T[]): { location: PantryLocation; items: T[] }[] {
  const map = new Map<PantryLocation, T[]>();
  for (const l of PANTRY_LOCATIONS) map.set(l.id, []);
  for (const item of items) {
    const loc = (PANTRY_LOCATIONS.find((l) => l.id === item.location)?.id ?? 'other') as PantryLocation;
    map.get(loc)!.push(item);
  }
  return [...map.entries()].filter(([, v]) => v.length > 0).map(([location, v]) => ({ location, items: v }));
}

/** Headline counts for the dashboard cards. */
export function pantrySummary(items: PantryLike[], todayKey: string) {
  const expiring = expiringSoon(items, 5, todayKey);
  return {
    total: items.length,
    expiringSoon: expiring.length,
    expired: items.filter((i) => expiryStatus(i.expires_at, todayKey).expired).length,
    lowStock: lowStockItems(items).length,
  };
}
