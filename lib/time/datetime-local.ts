// lib/time/datetime-local.ts — a `<input type="datetime-local">` value and the
// FAMILY's clock, in both directions.
//
// The input yields a naive `YYYY-MM-DDTHH:mm`: a wall reading with no zone. Two
// wrong readings of it shipped: written raw into a `timestamptz` column it is
// resolved in the database session's zone (UTC on Supabase), and passed through
// `new Date(value)` it is resolved in the DEVICE's zone. Neither is the family's,
// so a Los Angeles parent typing 2:30 PM saw 7:30 AM (TIME-003). Both directions
// go through the wall-clock helpers so no device setting can move the reading.
//
// Framework-free and safe in a client bundle.
import { wallAt, wallFromKey, wallKey, wallParts, wallToInstant } from '@/lib/time/wall-clock';

const DATETIME_LOCAL = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const pad = (n: number) => String(n).padStart(2, '0');

/**
 * The instant a `datetime-local` value names on the family's clock, as ISO
 * 8601 UTC; null when the value is blank or not a `YYYY-MM-DDTHH:mm` reading.
 */
export function datetimeLocalToInstant(value: string | null | undefined, timezone: string): string | null {
  const m = DATETIME_LOCAL.exec((value ?? '').trim());
  if (!m) return null;
  const wall = wallFromKey(m[1], Number(m[2]), Number(m[3]));
  if (Number.isNaN(wall.getTime())) return null;
  const hour = Number(m[2]);
  const minute = Number(m[3]);
  if (hour > 23 || minute > 59) return null;
  const instant = wallToInstant(wall, timezone);
  return Number.isNaN(instant.getTime()) ? null : instant.toISOString();
}

/**
 * A stored instant as the `YYYY-MM-DDTHH:mm` the family's clock shows, ready
 * for a `datetime-local` input; '' when the value is blank or unparseable.
 */
export function instantToDatetimeLocal(value: string | Date | null | undefined, timezone: string): string {
  if (!value) return '';
  const at = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(at.getTime())) return '';
  try {
    const wall = wallAt(at, timezone);
    const key = wallKey(wall);
    if (!key) return '';
    const parts = wallParts(wall);
    return `${key}T${pad(parts.hour)}:${pad(parts.minute)}`;
  } catch {
    return '';
  }
}
