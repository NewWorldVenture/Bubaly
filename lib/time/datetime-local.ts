// lib/time/datetime-local.ts — a `<input type="datetime-local">` value and the
// FAMILY's clock, in both directions.
//
// The input yields a naive `YYYY-MM-DDTHH:mm` (`:ss` and a fraction when the
// input has a `step`): a wall reading with no zone. Two wrong readings of it
// shipped: written raw into a `timestamptz` column it is resolved in the
// database session's zone (UTC on Supabase), and passed through
// `new Date(value)` it is resolved in the DEVICE's zone. Neither is the family's,
// so a Los Angeles parent typing 2:30 PM saw 7:30 AM (TIME-003).
//
// Both directions now go through `lib/time/civil.ts`, the one rule every
// zone-less reading in the product follows (RFC 5545 §3.3.5, as the calendar
// does): a repeated fall-back reading is the FIRST of its two instants in every
// zone, a skipped spring-forward reading keeps the offset in force before the
// gap (Los Angeles 02:30 on 8 March 2026 is 03:30 PDT), seconds are kept, and a
// date that does not exist (30 February) is refused rather than rolled.
//
// One consequence of a naive input, documented rather than hidden: the SECOND
// instant of a repeated hour (01:30 PST on 1 November in Los Angeles) reads
// back as `01:30`, and saving that reading names the first instant (01:30
// PDT). A wall clock cannot say which 01:30 it means; the rule picks one.
//
// Framework-free and safe in a client bundle.
import { civilToInstant, parseCivilReading } from '@/lib/time/civil';
import { wallAt, wallKey, wallParts } from '@/lib/time/wall-clock';

const DATETIME_LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?$/;
const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/**
 * The instant a `datetime-local` value names on the family's clock, as ISO
 * 8601 UTC; null when the value is blank, not a `YYYY-MM-DDTHH:mm[:ss[.fff]]`
 * reading, or a date or time that does not exist.
 */
export function datetimeLocalToInstant(value: string | null | undefined, timezone: string): string | null {
  const trimmed = (value ?? '').trim();
  if (!DATETIME_LOCAL.test(trimmed)) return null;
  const reading = parseCivilReading(trimmed);
  if (!reading) return null;
  const instant = civilToInstant(reading, timezone);
  return instant ? instant.toISOString() : null;
}

/**
 * A stored instant as the `YYYY-MM-DDTHH:mm` the family's clock shows, ready
 * for a `datetime-local` input — with `:ss` (and `.fff`) when the instant has
 * them, so a save does not quietly drop them; '' when the value is blank or
 * unparseable.
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
    // Every zone in use today is offset by whole minutes, so the seconds on the
    // family's clock are the instant's own.
    const seconds = at.getUTCSeconds();
    const ms = at.getUTCMilliseconds();
    const tail = ms ? `:${pad(seconds)}.${pad(ms, 3)}` : seconds ? `:${pad(seconds)}` : '';
    return `${key}T${pad(parts.hour)}:${pad(parts.minute)}${tail}`;
  } catch {
    return '';
  }
}
