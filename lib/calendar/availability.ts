import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../database.types';
import type { CalendarWindowBounds } from '../briefing/calendar-window';
import { isValidTimezone } from '../time/zoned';
import { validDay } from '../onboarding/ics-time';
import { allDayBusyInterval } from './event-dates';
import { readDisplayCalendarOccurrences, type CalendarDisplayOccurrence } from './display-occurrences';

export type CalendarAvailabilityAttribution = { kind: 'member'; memberId: string }
  | { kind: 'family'; reason: 'native-unassigned' | 'source-unmapped' };
export type CalendarAvailabilityOccurrence = CalendarDisplayOccurrence & {
  transparency: 'opaque' | 'transparent';
  attribution: CalendarAvailabilityAttribution;
  /** Clipped half-open occupied interval on the explicit household clock. */
  interval: { start: number; end: number };
  /** Transparency and explicit points never occupy a gap. Records stay visible. */
  occupied: boolean;
  point: boolean;
  estimatedEnd: boolean;
};
export type CalendarAvailabilityResult = { data: CalendarAvailabilityOccurrence[]; count: number; error: null }
  | { data: null; count: null; error: { message: string } };

function instant(value: unknown): number {
  if (typeof value !== 'string') throw new Error('Missing calendar instant');
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  const at = Date.parse(value);
  if (!match || !validDay(match[1]) || +match[2] > 23 || +match[3] > 59 || +match[4] > 59 || !Number.isFinite(at)) throw new Error('Invalid calendar instant');
  return at;
}
function identity(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function uuid(value: unknown): value is string { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value); }
function sourceReference(row: Extract<CalendarDisplayOccurrence, { kind: 'source' }>) {
  const ref = row.reference;
  if (!ref || ref.kind !== 'source' || !uuid(ref.feedId) || typeof ref.uid !== 'string' || !ref.uid || ref.uid.length > 8192 || !uuid(ref.revisionId)
    || !ref.original || !['date', 'utc', 'zoned', 'floating'].includes(ref.original.kind) || !identity(ref.original.value)
    || ref.original.kind === 'zoned' && !identity(ref.original.tzid)
    || row.readOnly !== true || row.assignee_id !== null || row.category !== null || 'event' in row) throw new Error('Unqualified source reference');
  const value = ref.original.value;
  const date = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  if (!validDay(date) || (ref.original.kind === 'date' ? !/^\d{8}$/.test(value)
    : !new RegExp(ref.original.kind === 'utc' ? '^\\d{8}T\\d{6}Z$' : '^\\d{8}T\\d{6}$').test(value)
      || +value.slice(9, 11) > 23 || +value.slice(11, 13) > 59 || +value.slice(13, 15) > 59)) throw new Error('Invalid source occurrence identity');
}

/** Staged read-only domain adapter. No caller may turn a display prefix into
 * availability, infer source attendees, or turn source identity into native IDs.
 * Capability selection and coherent snapshot admission belong to the reader. */
export async function readCalendarAvailability(
  db: SupabaseClient<Database>, familyId: string, bounds: CalendarWindowBounds, timezone: string,
): Promise<CalendarAvailabilityResult> {
  try {
    if (!identity(familyId) || typeof timezone !== 'string' || !timezone.trim() || !isValidTimezone(timezone)
      || !bounds || !validDay(bounds.allDayFromDay) || !validDay(bounds.allDayToDay) || bounds.allDayToDay <= bounds.allDayFromDay) throw new Error('Invalid calendar scope');
    const from = instant(bounds.timedFrom), to = instant(bounds.timedTo);
    if (to < from) throw new Error('Invalid calendar window');
    const result = await readDisplayCalendarOccurrences(db, familyId, bounds, timezone, { overlap: true });
    if (result.error) return { data: null, count: null, error: result.error };
    if (!Array.isArray(result.data) || !Number.isSafeInteger(result.count) || result.count < 0 || result.count > 20_000 || result.count !== result.data.length) throw new Error('Incomplete calendar domain');
    const keys = new Set<string>();
    const data = result.data.map((row): CalendarAvailabilityOccurrence => {
      if (!row || !identity(row.occurrenceKey) || keys.has(row.occurrenceKey) || typeof row.all_day !== 'boolean'
        || typeof row.readOnly !== 'boolean') throw new Error('Invalid calendar occurrence');
      keys.add(row.occurrenceKey);
      let attribution: CalendarAvailabilityAttribution;
      let transparency: 'opaque' | 'transparent';
      let estimatedEnd = false;
      if (row.kind === 'native') {
        if (!row.reference || row.reference.kind !== 'native' || !uuid(row.reference.eventId)
          || !row.event || row.event.id !== row.reference.eventId || row.event.family_id.toLowerCase() !== familyId.toLowerCase()
          || row.assignee_id !== row.event.assignee_id || row.assignee_id !== null && !identity(row.assignee_id)
          || row.category !== row.event.category || row.readOnly !== (row.event.feed_id !== null || row.event.external_uid !== null)
          || row.transparency !== undefined && row.transparency !== 'opaque') throw new Error('Unqualified native reference');
        transparency = 'opaque';
        attribution = row.assignee_id === null ? { kind: 'family', reason: 'native-unassigned' } : { kind: 'member', memberId: row.assignee_id };
        estimatedEnd = !row.all_day && row.event.ends_at === null;
      } else if (row.kind === 'source') {
        sourceReference(row);
        if (row.transparency !== 'opaque' && row.transparency !== 'transparent') throw new Error('Unqualified source transparency');
        transparency = row.transparency;
        attribution = { kind: 'family', reason: 'source-unmapped' };
      } else throw new Error('Invalid calendar kind');
      const start = instant(row.actualStartsAt);
      const end = row.actualEndsAt === null ? row.kind === 'native' && estimatedEnd ? start + 3_600_000 : NaN : instant(row.actualEndsAt);
      if (!Number.isFinite(end) || end < start) throw new Error('Invalid calendar interval');
      if (row.all_day) {
        if (!row.startDate || !row.endDate || !validDay(row.startDate) || !validDay(row.endDate) || row.endDate <= row.startDate
          || instant(row.starts_at) !== Date.parse(`${row.startDate}T00:00:00Z`)
          || row.ends_at !== null && instant(row.ends_at) !== Date.parse(`${row.endDate}T00:00:00Z`)) throw new Error('Invalid calendar DATE');
        const expected = allDayBusyInterval({ starts_at: `${row.startDate}T00:00:00Z`, ends_at: `${row.endDate}T00:00:00Z`, all_day: true }, timezone);
        if (start !== expected.start || end !== expected.end) throw new Error('Mismatched calendar DATE clock');
      } else if (start !== instant(row.starts_at)
        || end !== (row.ends_at === null && estimatedEnd ? start + 3_600_000 : instant(row.ends_at))) throw new Error('Mismatched calendar interval');
      const interval = { start: Math.min(to, Math.max(from, start)), end: Math.min(to, Math.max(from, end)) };
      return { ...row, transparency, attribution, interval, occupied: transparency === 'opaque' && interval.end > interval.start,
        point: !row.all_day && end === start, estimatedEnd };
    });
    return { data, count: data.length, error: null };
  } catch {
    return { data: null, count: null, error: { message: 'Calendar unavailable. Please refresh and try again.' } };
  }
}
