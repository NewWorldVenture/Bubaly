import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { instantCalendarBounds } from '@/lib/briefing/calendar-window';
import { isValidTimezone } from '@/lib/time/zoned';
import { validDay } from '@/lib/onboarding/ics-time';
import { allDayBusyInterval } from '@/lib/calendar/event-dates';
import { CALENDAR_SOURCE_ARCHIVE_ENABLED } from '@/lib/calendar/source-capability';
import { readCalendarOccurrences } from '@/lib/calendar/occurrences';
type Event = Database['public']['Tables']['calendar_events']['Row'];
const categories = [
  'general',
  'school',
  'sports',
  'appointment',
  'medication',
  'maintenance',
  'birthday',
  'holiday',
  'other',
];
const nullable = (value: unknown) => value === null || typeof value === 'string';
const uuid = (value: unknown) =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
function instant(value: unknown) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    !validDay(value.slice(0, 10)) ||
    +value.slice(11, 13) > 23 ||
    +value.slice(14, 16) > 59 ||
    +value.slice(17, 19) > 59 ||
    !Number.isFinite(Date.parse(value))
  )
    throw new Error('Invalid clock');
  return Date.parse(value);
}
function qualify(row: Event, familyId: string) {
  if (
    !row ||
    !uuid(row.id) ||
    typeof row.family_id !== 'string' ||
    row.family_id.toLowerCase() !== familyId.toLowerCase() ||
    typeof row.title !== 'string' ||
    typeof row.all_day !== 'boolean' ||
    !categories.includes(row.category) ||
    !['none', 'daily', 'weekly', 'monthly', 'yearly'].includes(row.recurrence) ||
    !nullable(row.recurrence_until) ||
    !nullable(row.assignee_id) ||
    !nullable(row.feed_id) ||
    !nullable(row.external_uid) ||
    !nullable(row.created_by) ||
    !nullable(row.onboarding_key) ||
    !nullable(row.idempotency_key) ||
    !nullable(row.description) ||
    !nullable(row.location) ||
    ('source_recurrence' in row && row.source_recurrence !== null)
  )
    throw new Error('Invalid native metadata');
  instant(row.created_at);
  instant(row.updated_at);
  if (row.recurrence_until !== null) instant(row.recurrence_until);
  const start = instant(row.starts_at),
    end = row.ends_at === null ? null : instant(row.ends_at);
  if (end !== null && end < start) throw new Error('Invalid interval');
  if (row.all_day) {
    if (
      start !== Date.parse(`${row.starts_at.slice(0, 10)}T00:00:00Z`) ||
      (end !== null && end !== Date.parse(`${row.ends_at!.slice(0, 10)}T00:00:00Z`))
    )
      throw new Error('Noncanonical DATE');
    allDayBusyInterval(row, 'UTC');
  }
}
type Result =
  { data: { today: Event[]; upcoming: Event[] }; error: null } | { data: null; error: { message: string } };
/** Start-based today; timed upcoming inclusive day14 midnight;
 * DATE upcoming tomorrow through day14 inclusive. No ongoing-history promotion. */
export async function readAssistantRailCalendar(
  db: SupabaseClient<Database>,
  familyId: string,
  tz: string,
  from: Date,
  tomorrow: Date,
  horizon: Date,
  signal: AbortSignal,
): Promise<Result> {
  try {
    if (CALENDAR_SOURCE_ARCHIVE_ENABLED || signal.aborted || !uuid(familyId) || !isValidTimezone(tz))
      throw new Error('Unavailable native scope');
    const start = instant(from.toISOString()),
      next = instant(tomorrow.toISOString()),
      last = instant(horizon.toISOString());
    if (next <= start || last <= next || last - start > 15 * 86400000) throw new Error('Invalid rail window');
    const bounds = instantCalendarBounds(from.toISOString(), horizon.toISOString(), tz);
    const tomorrowKey = instantCalendarBounds(
      tomorrow.toISOString(),
      tomorrow.toISOString(),
      tz,
    ).allDayFromDay;
    const result = await readCalendarOccurrences(db, familyId, bounds, tz, {
      signal,
      validateRow: (row) => qualify(row, familyId),
    });
    if (result.error) return { data: null, error: result.error };
    if (
      signal.aborted ||
      !Number.isSafeInteger(result.count) ||
      result.count !== result.data.length ||
      result.count > 20000
    )
      throw new Error('Incomplete native domain');
    const seen = new Set<string>();
    for (const row of result.data) {
      qualify(row, familyId);
      const key = JSON.stringify([row.id, row.starts_at]);
      if (seen.has(key)) throw new Error('Repeated occurrence');
      seen.add(key);
    }
    const today = result.data.filter((row) =>
      row.all_day
        ? row.starts_at.slice(0, 10) === bounds.allDayFromDay
        : instant(row.starts_at) >= start && instant(row.starts_at) < next,
    );
    const startInFamily = (row: Event) =>
      row.all_day ? allDayBusyInterval(row, tz).start : instant(row.starts_at);
    const upcoming = result.data
      .filter((row) =>
        row.all_day
          ? row.starts_at.slice(0, 10) >= tomorrowKey && row.starts_at.slice(0, 10) < bounds.allDayToDay
          : instant(row.starts_at) >= next && instant(row.starts_at) <= last,
      )
      .sort(
        (a, b) =>
          startInFamily(a) - startInFamily(b) ||
          a.id.localeCompare(b.id) ||
          a.starts_at.localeCompare(b.starts_at),
      );
    if (signal.aborted) throw new Error('Calendar request aborted');
    return { data: { today, upcoming: upcoming.slice(0, 4) }, error: null };
  } catch {
    return { data: null, error: { message: 'Complete native rail unavailable' } };
  }
}
