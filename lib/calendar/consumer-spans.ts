import { addDays } from './day';
import { calendarDisplayDay } from './display-spans';
import type { CalendarDisplayOccurrence } from './display-occurrences';
import type { CalendarSnapshotReference } from './source-snapshot';

/** Legacy native callers carry real database IDs; source rows retain their
 * discriminated reference and never acquire a fabricated native ID. */
export type CalendarConsumerEvent = CalendarDisplayOccurrence | {
  id: string; title: string | null; starts_at: string; ends_at?: string | null;
  all_day?: boolean | null; assignee_id?: string | null; location?: string | null;
};
export type CalendarInterval = {
  starts_at: string; ends_at?: string | null; all_day?: boolean | null;
  actualStartsAt?: string; actualEndsAt?: string | null;
  startDate?: string | null; endDate?: string | null; kind?: 'native' | 'source';
};
export function calendarConsumerKey(event: CalendarConsumerEvent): string {
  if ('occurrenceKey' in event) return event.occurrenceKey;
  if (!event.id) throw new Error('Missing native calendar identity');
  return JSON.stringify(['native',event.id,event.starts_at]);
}
export function calendarConsumerReference(event: CalendarConsumerEvent): CalendarSnapshotReference {
  return 'reference' in event ? event.reference : {kind:'native',eventId:event.id};
}
export function calendarConsumerNativeId(event: CalendarConsumerEvent): string | null {
  const reference=calendarConsumerReference(event);
  return reference.kind==='native'?reference.eventId:null;
}
function validDay(day:string):boolean {
  const at=Date.parse(`${day}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(at) && new Date(at).toISOString().slice(0,10)===day;
}
/** A civil DATE annotation survives a skipped date; timed occupancy is actual
 * elapsed overlap, including explicit zero-duration points and DST folds.
 * Missing native ends retain the existing qualified one-hour estimate. */
function normalize(event:CalendarInterval) {
  if(event.all_day) {
    const start=event.startDate??event.starts_at.slice(0,10);
    const end=event.endDate??(event.ends_at?event.ends_at.slice(0,10):addDays(start,1));
    if(!validDay(start)||!validDay(end)||end<=start)throw new Error('Invalid calendar DATE interval');
    return {allDay:true as const,start,end};
  }
  const start=Date.parse(event.actualStartsAt??event.starts_at);
  const rawEnd=event.actualEndsAt===undefined?event.ends_at:event.actualEndsAt;
  const end=rawEnd===null||rawEnd===undefined?start+(event.kind==='source'?0:3_600_000):Date.parse(rawEnd);
  if(!Number.isFinite(start)||!Number.isFinite(end)||end<start)throw new Error('Invalid calendar interval');
  return {allDay:false as const,start,end};
}
function spanInWindow(event:ReturnType<typeof normalize>,day:string,window:ReturnType<typeof calendarDisplayDay>) {
  if(event.allDay)return event.start<=day && day<event.end?{day,actualStartsAt:new Date(window.start).toISOString(),actualEndsAt:new Date(window.end).toISOString()}:null;
  const {start,end}=event;
  if(window.start===window.end || start>=window.end || !(end>window.start || end===start && start>=window.start))return null;
  return {day,actualStartsAt:new Date(Math.max(start,window.start)).toISOString(),actualEndsAt:new Date(Math.min(end,window.end)).toISOString()};
}
export function calendarConsumerSpan(event: CalendarInterval, day:string, timezone:string) {
  const window=calendarDisplayDay(day,timezone);
  return spanInWindow(normalize(event),day,window);
}
export function projectCalendarDay<T extends CalendarInterval>(events:readonly T[],day:string,timezone:string) {
  const window=calendarDisplayDay(day,timezone);
  if(events.length>20_000)throw new Error('Calendar consumer bound exhausted');
  return events.flatMap(event=>{const span=spanInWindow(normalize(event),day,window);return span?[{...event,displayStartsAt:span.actualStartsAt,displayEndsAt:span.actualEndsAt,displayDay:span.day}]:[];})
    .sort((a,b)=>Number(!!b.all_day)-Number(!!a.all_day)||a.displayStartsAt.localeCompare(b.displayStartsAt));
}
/** First visible segment per original occurrence, before presentation caps.
 * Each family-day boundary and original interval is resolved only once. */
export function projectCalendarWindow<T extends CalendarInterval>(events:readonly T[],fromDay:string,toDay:string,timezone:string) {
  calendarDisplayDay(fromDay,timezone);calendarDisplayDay(toDay,timezone);
  if(toDay<fromDay||events.length>20_000)throw new Error('Invalid calendar consumer window');
  const days:{day:string;window:ReturnType<typeof calendarDisplayDay>}[]=[];
  for(let day=fromDay;day<toDay;day=addDays(day,1)){if(days.length>=366)throw new Error('Calendar consumer window bound exhausted');days.push({day,window:calendarDisplayDay(day,timezone)});}
  return events.flatMap(event=>{const interval=normalize(event);for(const {day,window} of days){const span=spanInWindow(interval,day,window);if(span)return [{...event,displayStartsAt:span.actualStartsAt,displayEndsAt:span.actualEndsAt,displayDay:span.day}];}return [];})
    .sort((a,b)=>a.displayDay.localeCompare(b.displayDay)||Number(!!b.all_day)-Number(!!a.all_day)||a.displayStartsAt.localeCompare(b.displayStartsAt));
}
