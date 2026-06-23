// lib/pantry/logic.ts — pure helpers for Pantry / Inventory / Expiration tracking.
// No I/O here so it's fully unit-testable; the module + API call into it.

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

/** Whole days from `now` until the date (negative = already past). */
export function daysUntil(dateStr: string | null | undefined, now: number = Date.now()): number | null {
  if (!dateStr) return null;
  const t = new Date(`${dateStr}T00:00:00`).getTime();
  if (!Number.isFinite(t)) return null;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  return Math.round((t - today.getTime()) / 86400000);
}

/**
 * Expiration status for a best-by date. Tiers, soonest first:
 *   expired (<0) · today (0) · soon (≤3) · this week (≤7) · ok (>7) · none.
 */
export function expiryStatus(dateStr: string | null | undefined, now: number = Date.now()): {
  tone: ExpiryTone; label: string; days: number | null; expired: boolean;
} {
  const days = daysUntil(dateStr, now);
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
export function expiringSoon<T extends PantryLike>(items: T[], withinDays = 5, now: number = Date.now()): T[] {
  return items
    .filter((i) => {
      const d = daysUntil(i.expires_at, now);
      return d !== null && d <= withinDays;
    })
    .sort((a, b) => (daysUntil(a.expires_at, now) ?? 0) - (daysUntil(b.expires_at, now) ?? 0));
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
export function pantrySummary(items: PantryLike[], now: number = Date.now()) {
  const expiring = expiringSoon(items, 5, now);
  return {
    total: items.length,
    expiringSoon: expiring.length,
    expired: items.filter((i) => expiryStatus(i.expires_at, now).expired).length,
    lowStock: lowStockItems(items).length,
  };
}
