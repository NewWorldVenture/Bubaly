import 'server-only';
import type { EventCategory, Tables } from '@/lib/database.types';
import { instantCalendarBounds } from '@/lib/briefing/calendar-window';
import { readCalendarAvailability, type CalendarAvailabilityOccurrence } from '@/lib/calendar/availability';
import { conflictSubject } from '@/lib/calendar/conflict-advisories';
import { validDay } from '@/lib/onboarding/ics-time';
import { isValidTimezone } from '@/lib/time/zoned';
import { fail, ok, SERVICE_CODES, type ServiceResult, type ServiceScope } from '../types';

export type SearchCalendarOccurrencesInput = {
  from: string; to: string; query?: string; assigneeId?: string; category?: EventCategory; limit?: number;
};
const CATEGORIES: readonly EventCategory[] = ['general', 'school', 'sports', 'appointment', 'medication', 'maintenance', 'birthday', 'holiday', 'other'];
type Common = Pick<CalendarAvailabilityOccurrence, 'title' | 'description' | 'location' | 'starts_at' | 'ends_at' | 'all_day'
  | 'actualStartsAt' | 'actualEndsAt' | 'startDate' | 'endDate' | 'occurrenceKey' | 'transparency' | 'occupied'
  | 'point' | 'estimatedEnd' | 'interval'> & { displayOrder: number; readOnly: boolean; mutable: boolean };
export type NativeSearchOccurrence = Tables<'calendar_events'> & Common & {
  kind: 'native'; eventId: string; reference: Extract<CalendarAvailabilityOccurrence['reference'], { kind: 'native' }>;
};
export type SourceSearchOccurrence = Common & {
  kind: 'source'; readOnly: true; mutable: false;
  reference: Extract<CalendarAvailabilityOccurrence['reference'], { kind: 'source' }>;
};
export type SearchCalendarOccurrencesResult = {
  events: NativeSearchOccurrence[]; source_events: SourceSearchOccurrence[];
  totalVisibleCount: number; matchedCount: number; returnedCount: number; truncated: boolean; horizonEndsAt: string;
  filterScope: { native: 'requested-filters'; sources: 'unmapped-family-context'; sourceMemberCategoryMatched: false };
};

function strictInstant(value: unknown): number {
  if (typeof value !== 'string') throw new Error('Missing calendar clock');
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  const instant = Date.parse(value);
  if (!match || !validDay(match[1]) || +match[2] > 23 || +match[3] > 59 || +match[4] > 59
    || match[6] !== undefined && (+match[6] > 23 || +match[7] > 59) || !Number.isFinite(instant)) throw new Error('Invalid calendar clock');
  return instant;
}

function nullableText(value: unknown): boolean { return value === null || typeof value === 'string'; }
/** Admit stored masters even when expansion produces no visible occurrence. */
function qualifyNativeRow(event: Tables<'calendar_events'>, familyId: string): void {
  const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  if (!event || !uuid(event.id) || typeof event.family_id !== 'string' || event.family_id.toLowerCase() !== familyId.toLowerCase()
    || typeof event.all_day !== 'boolean' || typeof event.title !== 'string' || !CATEGORIES.includes(event.category)
    || !nullableText(event.description) || !nullableText(event.location)
    || !['none', 'daily', 'weekly', 'monthly', 'yearly'].includes(event.recurrence)
    || !nullableText(event.recurrence_until) || !nullableText(event.assignee_id) || !nullableText(event.feed_id)
    || !nullableText(event.external_uid) || !nullableText(event.created_by) || !nullableText(event.onboarding_key)
    || !nullableText(event.idempotency_key) || event.assignee_id !== null && !event.assignee_id.trim()
    || 'source_recurrence' in event && event.source_recurrence !== null) throw new Error('Unqualified native calendar row');
  const start = strictInstant(event.starts_at), end = event.ends_at === null ? null : strictInstant(event.ends_at);
  if (end !== null && end < start) throw new Error('Invalid native calendar interval');
  if (event.all_day && (end !== null && end <= start || start !== Date.parse(`${event.starts_at.slice(0, 10)}T00:00:00Z`)
    || end !== null && end !== Date.parse(`${event.ends_at!.slice(0, 10)}T00:00:00Z`))) throw new Error('Invalid native calendar DATE');
  if (event.recurrence_until !== null) strictInstant(event.recurrence_until);
  strictInstant(event.created_at); strictInstant(event.updated_at);
}

function qualifySearchProjection(row: CalendarAvailabilityOccurrence): void {
  conflictSubject(row);
  if (!nullableText(row.title) || !nullableText(row.description) || !nullableText(row.location)) throw new Error('Invalid calendar presentation');
  if (row.kind === 'native') {
    const event = row.event;
    if (typeof event.title !== 'string' || row.title !== event.title || !CATEGORIES.includes(event.category)
      || !nullableText(event.description) || !nullableText(event.location) || row.description !== event.description || row.location !== event.location
      || !['none', 'daily', 'weekly', 'monthly', 'yearly'].includes(event.recurrence)
      || !nullableText(event.recurrence_until) || !nullableText(event.assignee_id) || !nullableText(event.feed_id)
      || !nullableText(event.external_uid) || !nullableText(event.created_by) || !nullableText(event.onboarding_key)
      || !nullableText(event.idempotency_key)) throw new Error('Invalid native calendar presentation');
    if (event.recurrence_until !== null) strictInstant(event.recurrence_until);
    strictInstant(event.created_at); strictInstant(event.updated_at);
  }
}

/** Shared with the assistant so invalid clocks refuse before member lookup. To is inclusive. */
export function validateCalendarSearchWindow(scope: Pick<ServiceScope, 'familyId' | 'tz'>, input: { from: string; to: string }) {
  if (!scope || typeof scope.familyId !== 'string' || !scope.familyId.trim()
    || typeof scope.tz !== 'string' || !scope.tz.trim() || !isValidTimezone(scope.tz) || !input) throw new Error('Invalid calendar scope');
  const from = strictInstant(input.from), to = strictInstant(input.to);
  if (to < from || to - from + 1 > 366 * 86_400_000) throw new Error('Invalid calendar window');
  const fromIso = new Date(from).toISOString(), toIso = new Date(to).toISOString();
  return { from: fromIso, to: toIso, bounds: instantCalendarBounds(fromIso, toIso, scope.tz) };
}

/** Internal civil-window policy. A valid 366-day family span can exceed 366
 * elapsed days when the two years' DST dates differ. The assistant's public
 * search keeps its separate 366-elapsed-day contract above. */
export function validateCalendarCivilWindow(scope: Pick<ServiceScope, 'familyId' | 'tz'>, input: { from: string; to: string }) {
  if (!scope || typeof scope.familyId !== 'string' || !scope.familyId.trim()
    || typeof scope.tz !== 'string' || !scope.tz.trim() || !isValidTimezone(scope.tz) || !input) throw new Error('Invalid calendar scope');
  const from = strictInstant(input.from), to = strictInstant(input.to);
  if (to < from || to - from + 1 > 367 * 86_400_000) throw new Error('Invalid civil calendar window');
  const fromIso = new Date(from).toISOString(), toIso = new Date(to).toISOString();
  const bounds = instantCalendarBounds(fromIso, toIso, scope.tz);
  const days = (Date.parse(bounds.allDayToDay + 'T00:00:00Z') - Date.parse(bounds.allDayFromDay + 'T00:00:00Z')) / 86_400_000;
  if (!Number.isSafeInteger(days) || days < 1 || days > 366) throw new Error('Invalid civil calendar days');
  return { from: fromIso, to: toIso, bounds };
}

/** Complete bounded search. Sources stay unmapped family context, even when a
 * native member/category selector is supplied. No query or display cap reaches
 * the shared reader: admission must succeed for the entire domain first. */
export async function searchCalendarOccurrences(scope: ServiceScope, input: SearchCalendarOccurrencesInput): Promise<ServiceResult<SearchCalendarOccurrencesResult>> {
  let window: ReturnType<typeof validateCalendarSearchWindow>;
  try {
    window = validateCalendarSearchWindow(scope, input);
    if (input.query !== undefined && typeof input.query !== 'string'
      || input.assigneeId !== undefined && (typeof input.assigneeId !== 'string' || !input.assigneeId.trim())
      || input.category !== undefined && !CATEGORIES.includes(input.category)
      || input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 200)) throw new Error('Invalid calendar search');
  } catch { return fail('That calendar search could not be understood.', { code: SERVICE_CODES.invalidInput }); }
  const qualified = await readCompleteCalendarOccurrences(scope, input);
  if (!qualified.ok) return qualified;
  const result = { data: qualified.data.occurrences, count: qualified.data.totalVisibleCount };
  try {
    const query = input.query?.trim().toLowerCase() ?? '';
    const matched = result.data.filter(row => (!query || (row.title ?? '').toLowerCase().includes(query))
      && (row.kind === 'source' || ((!input.assigneeId || row.assignee_id === input.assigneeId)
        && (!input.category || row.category === input.category))))
      .sort((a, b) => Date.parse(a.actualStartsAt) - Date.parse(b.actualStartsAt)
        || (a.occurrenceKey < b.occurrenceKey ? -1 : a.occurrenceKey > b.occurrenceKey ? 1 : 0));
    const events: NativeSearchOccurrence[] = [], source_events: SourceSearchOccurrence[] = [];
    matched.slice(0, input.limit ?? 50).forEach((row, displayOrder) => {
      const common: Common = { title: row.title, description: row.description, location: row.location, starts_at: row.starts_at,
        ends_at: row.ends_at, all_day: row.all_day, actualStartsAt: row.actualStartsAt, actualEndsAt: row.actualEndsAt,
        startDate: row.startDate, endDate: row.endDate, occurrenceKey: row.occurrenceKey, transparency: row.transparency,
        occupied: row.occupied, point: row.point, estimatedEnd: row.estimatedEnd, interval: row.interval,
        displayOrder, readOnly: row.readOnly, mutable: !row.readOnly };
      if (row.kind === 'native') events.push({ ...row.event, ...common, title: row.event.title,
        kind: 'native', eventId: row.reference.eventId, reference: row.reference });
      else source_events.push({ ...common, kind: 'source', reference: row.reference, readOnly: true, mutable: false });
    });
    const returnedCount = events.length + source_events.length;
    return ok({ events, source_events, totalVisibleCount: result.count, matchedCount: matched.length, returnedCount,
      truncated: returnedCount < matched.length, horizonEndsAt: window.to,
      filterScope: { native: 'requested-filters', sources: 'unmapped-family-context', sourceMemberCategoryMatched: false } });
  } catch { return fail('Could not load the complete calendar.', { code: SERVICE_CODES.db }); }
}

/** Complete qualified domain, before any title filter or presentation cap. */
export async function readCompleteCalendarOccurrences(scope: ServiceScope, input: { from: string; to: string }): Promise<ServiceResult<{
  occurrences: CalendarAvailabilityOccurrence[]; totalVisibleCount: number; horizonEndsAt: string;
}>> {
  let window: ReturnType<typeof validateCalendarSearchWindow>;
  try { window = validateCalendarSearchWindow(scope, input); }
  catch { return fail('That calendar search could not be understood.', { code: SERVICE_CODES.invalidInput }); }
  return readQualifiedCalendarWindow(scope, window);
}

/** Internal complete civil read; no presentation cap or source activation.
 * Callers remain responsible for their own source/write capability policy. */
export async function readCompleteCalendarCivilOccurrences(scope: ServiceScope, input: { from: string; to: string }): ReturnType<typeof readCompleteCalendarOccurrences> {
  let window: ReturnType<typeof validateCalendarCivilWindow>;
  try { window = validateCalendarCivilWindow(scope, input); }
  catch { return fail('That civil calendar window could not be understood.', { code: SERVICE_CODES.invalidInput }); }
  return readQualifiedCalendarWindow(scope, window);
}

async function readQualifiedCalendarWindow(scope: ServiceScope, window: ReturnType<typeof validateCalendarSearchWindow>): ReturnType<typeof readCompleteCalendarOccurrences> {
  const result = await readCalendarAvailability(scope.db, scope.familyId, window.bounds, scope.tz, {
    validateNativeRow: row => qualifyNativeRow(row, scope.familyId),
  });
  if (result.error) return fail('Could not load the complete calendar.', { code: SERVICE_CODES.db });
  try {
    if (!Number.isSafeInteger(result.count) || result.count !== result.data.length || result.count > 20_000) throw new Error('Incomplete calendar');
    for (const row of result.data) qualifySearchProjection(row);
    return ok({ occurrences: result.data, totalVisibleCount: result.count, horizonEndsAt: window.to });
  } catch { return fail('Could not load the complete calendar.', { code: SERVICE_CODES.db }); }
}

/** Lossless public projection for a qualified complete domain. */
export function projectCalendarOccurrences(rows: CalendarAvailabilityOccurrence[]): { events: NativeSearchOccurrence[]; source_events: SourceSearchOccurrence[] } {
  const events: NativeSearchOccurrence[] = [], source_events: SourceSearchOccurrence[] = [];
  [...rows].sort((a,b) => Date.parse(a.actualStartsAt) - Date.parse(b.actualStartsAt) || (a.occurrenceKey < b.occurrenceKey ? -1 : a.occurrenceKey > b.occurrenceKey ? 1 : 0)).forEach((row, displayOrder) => {
    const common: Common = { title: row.title, description: row.description, location: row.location, starts_at: row.starts_at,
      ends_at: row.ends_at, all_day: row.all_day, actualStartsAt: row.actualStartsAt, actualEndsAt: row.actualEndsAt,
      startDate: row.startDate, endDate: row.endDate, occurrenceKey: row.occurrenceKey, transparency: row.transparency,
      occupied: row.occupied, point: row.point, estimatedEnd: row.estimatedEnd, interval: row.interval,
      displayOrder, readOnly: row.readOnly, mutable: !row.readOnly };
    if (row.kind === 'native') events.push({ ...row.event, ...common, title: row.event.title,
      kind: 'native', eventId: row.reference.eventId, reference: row.reference });
    else source_events.push({ ...common, kind: 'source', reference: row.reference, readOnly: true, mutable: false });
  });
  return { events, source_events };
}
