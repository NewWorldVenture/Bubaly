// Small, dependency-light formatting helpers shared across the app.
//
// HARDENED: date-fns `format`/`isToday`/`formatDistanceToNow` all THROW
// (`RangeError: Invalid time value`) on an Invalid Date — which let a single
// malformed timestamp in the data crash an entire route (the Kitchen Display
// kiosk hit exactly this in prod). `parseISO` also rejects Postgres-style
// timestamps ("2026-07-14 22:00:00+00", space instead of "T") that arrive via
// SQL-editor seeds and non-PostgREST paths. Every helper here now parses
// tolerantly and returns '' instead of throwing — a bad date renders blank,
// never a crash.
import { format, formatDistanceToNow, isToday, isTomorrow, parseISO } from 'date-fns';

/** Tolerant parse: ISO first, then native Date (accepts Postgres "YYYY-MM-DD HH:mm:ss+TZ"). */
function toDate(value: string | Date): Date | null {
  const d = typeof value === 'string' ? parseISO(value) : value;
  if (!Number.isNaN(d.getTime())) return d;
  if (typeof value === 'string') {
    const fallback = new Date(value);
    if (!Number.isNaN(fallback.getTime())) return fallback;
  }
  return null;
}

export function fmtDate(value: string | Date | null | undefined, pattern = 'EEE, MMM d'): string {
  if (!value) return '';
  const d = toDate(value);
  return d ? format(d, pattern) : '';
}

export function fmtTime(value: string | Date | null | undefined): string {
  if (!value) return '';
  const d = toDate(value);
  return d ? format(d, 'h:mm a') : '';
}

export function fmtDateTime(value: string | Date | null | undefined): string {
  if (!value) return '';
  const d = toDate(value);
  return d ? format(d, "EEE, MMM d 'at' h:mm a") : '';
}

/** Friendly relative label for upcoming/overdue items. */
export function fmtRelative(value: string | Date | null | undefined): string {
  if (!value) return '';
  const d = toDate(value);
  if (!d) return '';
  if (isToday(d)) return `Today, ${format(d, 'h:mm a')}`;
  if (isTomorrow(d)) return `Tomorrow, ${format(d, 'h:mm a')}`;
  return formatDistanceToNow(d, { addSuffix: true });
}

export function initials(name: string | null | undefined): string {
  if (!name) return '?';
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}

// Null-safe first-name/label. `family_members.display_name` is nullable in the
// DB but typed `string`, so a raw `name.split(' ')[0]` throws during render for
// a member with a null name — which white-screened the Kitchen Display (the
// "Reconnecting…" loop). Every UI site must go through this instead.
export function firstName(name: string | null | undefined): string {
  return (name ?? '').trim().split(/\s+/)[0] || 'Member';
}

const CURRENCY = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
export const fmtMoney = (cents: number) => CURRENCY.format(cents / 100);
