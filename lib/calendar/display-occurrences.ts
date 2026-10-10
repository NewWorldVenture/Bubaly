import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, EventCategory, Tables } from '../database.types';
import type { CalendarWindowBounds } from '../briefing/calendar-window';
import { allDayBusyInterval } from './event-dates';
import { CALENDAR_SOURCE_ARCHIVE_ENABLED } from './source-capability';
import type { SourceTransparency } from './source-occurrences';
import { readCalendarOccurrences, type CalendarOccurrence } from './occurrences';
import { materializeCalendarSourceSnapshot, readCalendarSourceSnapshot, type CalendarSnapshotReference } from './source-snapshot';
import { compareExactInstants } from './exact-instant';

export { CALENDAR_SOURCE_ARCHIVE_ENABLED } from './source-capability';
export const CALENDAR_DISPLAY_CONTRACT = 3;
type NativeEvent = Tables<'calendar_events'>;
export type NativeCalendarRowValidator = (row: CalendarOccurrence<keyof NativeEvent>) => void;
type Common = {
  /** Optional for older cached shapes; every actual read emits a qualified value. */
  transparency?: SourceTransparency;
  occurrenceKey: string; readOnly: boolean; title: string | null; description: string | null; location: string | null;
  /** Source ICS categories/attendees are not native category/member mappings. */
  category: EventCategory | null; assignee_id: string | null;
  starts_at: string; ends_at: string | null; all_day: boolean;
  actualStartsAt: string; actualEndsAt: string | null; startDate: string | null; endDate: string | null;
};
export type CalendarDisplayOccurrence = Common & (
  | { kind: 'native'; reference: Extract<CalendarSnapshotReference,{kind:'native'}>; event: NativeEvent }
  | { kind: 'source'; reference: Extract<CalendarSnapshotReference,{kind:'source'}> }
);
export type CalendarDisplayResult = { data: CalendarDisplayOccurrence[]; count: number; error: null }
  | { data: null; count: null; error: {message:string} };

function nativeDisplay(event: NativeEvent): CalendarDisplayOccurrence {
  const busy = event.all_day ? allDayBusyInterval(event,'UTC') : null;
  const startDate = event.all_day ? event.starts_at.slice(0,10) : null;
  return { transparency:'opaque',kind:'native',reference:{kind:'native',eventId:event.id},event,occurrenceKey:JSON.stringify(['native',event.id,event.starts_at]),
    readOnly:event.feed_id !== null || event.external_uid !== null,title:event.title,description:event.description,location:event.location,category:event.category,assignee_id:event.assignee_id,
    starts_at:event.starts_at,ends_at:event.ends_at,all_day:event.all_day,startDate,
    endDate:event.all_day ? event.ends_at?.slice(0,10) ?? new Date(Date.parse(event.starts_at)+86_400_000).toISOString().slice(0,10) : null,
    actualStartsAt:busy ? new Date(busy.start).toISOString() : event.starts_at,actualEndsAt:busy ? new Date(busy.end).toISOString() : event.ends_at };
}

/** Explicit display consumer. Other generic calendar readers remain separate
 * until their filters and mutation contracts have been migrated. */
export async function readDisplayCalendarOccurrences(db: SupabaseClient<Database>, familyId: string, bounds: CalendarWindowBounds, timezone: string, options: {overlap?:boolean;limit?:number;validateNativeRow?:NativeCalendarRowValidator} = {}): Promise<CalendarDisplayResult> {
  try {
    if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1)) throw new Error('Invalid calendar display limit');
    if (!CALENDAR_SOURCE_ARCHIVE_ENABLED) {
      const result = await readCalendarOccurrences(db,familyId,bounds,timezone,{overlap:options.overlap,limit:options.limit,validateRow:options.validateNativeRow});
      if (result.error) return {data:null,count:null,error:result.error};
      const data = result.data.map(event => {
        if ('source_recurrence' in event && event.source_recurrence !== null) throw new Error('Unreconciled legacy source projection');
        const display = nativeDisplay(event);
        if (event.all_day) {
          const busy = allDayBusyInterval(event,timezone);
          display.actualStartsAt = new Date(busy.start).toISOString(); display.actualEndsAt = new Date(busy.end).toISOString();
        }
        return display;
      });
      return {data,count:result.count,error:null};
    }
    const snapshot = await readCalendarSourceSnapshot(db,familyId);
    const result = materializeCalendarSourceSnapshot(snapshot,{familyId,bounds,timezone});
    const native = new Map(snapshot.nativeRows.map(event => [event.id,event]));
    const all: CalendarDisplayOccurrence[] = result.occurrences.filter(row => options.overlap || (row.all_day
      ? row.startDate! >= bounds.allDayFromDay && row.startDate! < bounds.allDayToDay
      : compareExactInstants(row.actualStartsAt,bounds.timedFrom) >= 0 && compareExactInstants(row.actualStartsAt,bounds.timedTo) < 0)).map(row => {
      if (row.reference.kind === 'source') return {...row,kind:'source' as const,reference:row.reference,category:null,assignee_id:null};
      const original = native.get(row.reference.eventId);
      if (!original) throw new Error('Missing native snapshot identity');
      const event = {...original,starts_at:row.starts_at,ends_at:row.ends_at};
      return {...row,kind:'native' as const,reference:row.reference,event,category:event.category,assignee_id:event.assignee_id};
    });
    return {data:options.limit === undefined ? all : all.slice(0,options.limit),count:all.length,error:null};
  } catch {
    // No legacy fallback after an enabled archive read fails. Neither the
    // user's provider source nor internal database details enter this error.
    return {data:null,count:null,error:{message:'Calendar unavailable. Please refresh and try again.'}};
  }
}
