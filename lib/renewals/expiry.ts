// lib/renewals/expiry.ts — pure helpers for the Renewals & Expirations tracker.
//
// No Supabase / React imports. Distinct from the signups tracker: each renewal
// carries its OWN reminder lead time (reminder_days), so "expiring soon" is
// per-item rather than a fixed global window.

export type RenewalStatus = 'active' | 'renewed' | 'expired' | 'cancelled';

export interface RenewalLike {
  id: string;
  expires_at: string;     // YYYY-MM-DD
  reminder_days: number;
  status: RenewalStatus;
}

const MS_DAY = 24 * 60 * 60 * 1000;

function dayDiff(aKey: string, bKey: string): number {
  const a = Date.UTC(+aKey.slice(0, 4), +aKey.slice(5, 7) - 1, +aKey.slice(8, 10));
  const b = Date.UTC(+bKey.slice(0, 4), +bKey.slice(5, 7) - 1, +bKey.slice(8, 10));
  return Math.round((b - a) / MS_DAY);
}

/** Whole days until expiry from `todayKey` (negative when already expired). */
export function daysToExpiry(r: RenewalLike, todayKey: string): number {
  return dayDiff(todayKey, r.expires_at);
}

/** Only 'active' renewals are still being tracked toward expiry. */
export function isActive(r: RenewalLike): boolean {
  return r.status === 'active';
}

/** Active renewal whose expiry date has passed. */
export function isExpired(r: RenewalLike, todayKey: string): boolean {
  return isActive(r) && daysToExpiry(r, todayKey) < 0;
}

/** Active renewal within its own reminder window (and not yet expired). */
export function isExpiringSoon(r: RenewalLike, todayKey: string): boolean {
  if (!isActive(r)) return false;
  const d = daysToExpiry(r, todayKey);
  return d >= 0 && d <= r.reminder_days;
}

export type ExpiryBucket = 'expired' | 'soon' | 'upcoming' | 'done';

export function expiryBucket(r: RenewalLike, todayKey: string): ExpiryBucket {
  if (!isActive(r)) return 'done';
  const d = daysToExpiry(r, todayKey);
  if (d < 0) return 'expired';
  if (d <= r.reminder_days) return 'soon';
  return 'upcoming';
}

/** Groups renewals into ordered buckets; active buckets sorted by expiry date. */
export function groupByExpiry<T extends RenewalLike>(items: T[], todayKey: string): Record<ExpiryBucket, T[]> {
  const out: Record<ExpiryBucket, T[]> = { expired: [], soon: [], upcoming: [], done: [] };
  for (const r of items) out[expiryBucket(r, todayKey)].push(r);
  const byExpiry = (a: T, b: T) => a.expires_at.localeCompare(b.expires_at);
  out.expired.sort(byExpiry); out.soon.sort(byExpiry); out.upcoming.sort(byExpiry);
  return out;
}

export interface RenewalStats {
  active: number;
  expiringSoon: number;
  expired: number;
}

export function renewalStats(items: RenewalLike[], todayKey: string): RenewalStats {
  return {
    active: items.filter(isActive).length,
    expiringSoon: items.filter((r) => isExpiringSoon(r, todayKey)).length,
    expired: items.filter((r) => isExpired(r, todayKey)).length,
  };
}

/**
 * Rolls an expiry date forward by a number of months — used by the "Mark
 * renewed" action to advance to the next cycle (default 12 months / annual).
 * Returns a YYYY-MM-DD key.
 */
export function rollForward(expiresAt: string, months = 12): string {
  const [y, m, d] = expiresAt.split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  base.setUTCMonth(base.getUTCMonth() + months);
  return base.toISOString().slice(0, 10);
}

export const RENEWAL_STATUS_LABELS: Record<RenewalStatus, string> = {
  active: 'Active', renewed: 'Renewed', expired: 'Expired', cancelled: 'Cancelled',
};
export const EXPIRY_BUCKET_LABELS: Record<ExpiryBucket, string> = {
  expired: 'Expired', soon: 'Expiring soon', upcoming: 'Upcoming', done: 'Renewed / closed',
};
