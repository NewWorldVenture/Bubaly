// School reads: the events, homework and timetable the week planner, the
// daily brief and the free-slot search all need to see before promising a
// family an evening is free.
//
// Backed by `school_events` (0002), `homework_assignments` (0030) and
// `school_classes` (0006, `week_pattern` added later for A/B timetables).
// Everything here is read-only — the school module writes its own rows — and
// every query filters `family_id` explicitly so the same code serves a cron
// holding the service client.
//
// `school_events` carries no recurrence column, so a window read is exact:
// what the table holds is what the family put there.
import 'server-only';
import type { HomeworkStatus, Tables } from '@/lib/database.types';
import { classOccursInWeek, slotStartMinutes, weekParity } from '@/lib/school/timetable';
import { describeDbError } from '@/lib/supabase/errors';
import { scopeNow } from '../scope';
import { fail, ok, SERVICE_CODES, type ServiceResult, type ServiceScope } from '../types';

export type SchoolEventRow = Tables<'school_events'>;
export type HomeworkRow = Tables<'homework_assignments'>;
export type SchoolClassRow = Tables<'school_classes'>;

const WEEK_MS = 7 * 86_400_000;
const MAX_ROWS = 500;

function isoOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** A window defaulting to the coming week; an inverted window is refused rather than returned empty. */
export function resolveWindow(scope: ServiceScope, input?: { from?: string | null; to?: string | null }): ServiceResult<{ from: string; to: string }> {
  const from = isoOrNull(input?.from) ?? scopeNow(scope).toISOString();
  const to = isoOrNull(input?.to) ?? new Date(Date.parse(from) + WEEK_MS).toISOString();
  if (input?.from && !isoOrNull(input.from)) return fail('That start time could not be understood.', { code: SERVICE_CODES.invalidInput });
  if (input?.to && !isoOrNull(input.to)) return fail('That end time could not be understood.', { code: SERVICE_CODES.invalidInput });
  if (Date.parse(to) < Date.parse(from)) return fail('The end of that window is before its start.', { code: SERVICE_CODES.invalidInput });
  return ok({ from, to });
}

export type SchoolWindowInput = { from?: string | null; to?: string | null; memberId?: string | null; limit?: number };

/** School events starting in a window, soonest first. */
export async function listEventsBetween(scope: ServiceScope, input: SchoolWindowInput = {}): Promise<ServiceResult<SchoolEventRow[]>> {
  const window = resolveWindow(scope, input);
  if (!window.ok) return window;
  let query = scope.db
    .from('school_events')
    .select('*')
    .eq('family_id', scope.familyId)
    .gte('starts_at', window.data.from)
    .lte('starts_at', window.data.to)
    .order('starts_at', { ascending: true })
    .limit(Math.min(Math.max(input.limit ?? 200, 1), MAX_ROWS));
  if (input.memberId) query = query.eq('member_id', input.memberId);
  const { data, error } = await query;
  if (error) {
    console.error('[service:school] events read failed', error);
    return fail(describeDbError(error, 'Could not load school events.'), { code: SERVICE_CODES.db });
  }
  return ok(data ?? []);
}

export type HomeworkDueInput = SchoolWindowInput & { includeDone?: boolean };

const OPEN_STATUSES: HomeworkStatus[] = ['assigned', 'in_progress'];

/**
 * Homework due in a window, soonest first. Completed work is excluded by
 * default because every caller is asking "what still needs doing"; overdue
 * open work is included when `from` reaches back far enough to cover it.
 */
export async function listHomeworkDue(scope: ServiceScope, input: HomeworkDueInput = {}): Promise<ServiceResult<HomeworkRow[]>> {
  const window = resolveWindow(scope, input);
  if (!window.ok) return window;
  let query = scope.db
    .from('homework_assignments')
    .select('*')
    .eq('family_id', scope.familyId)
    .not('due_at', 'is', null)
    .gte('due_at', window.data.from)
    .lte('due_at', window.data.to)
    .order('due_at', { ascending: true })
    .limit(Math.min(Math.max(input.limit ?? 200, 1), MAX_ROWS));
  if (!input.includeDone) query = query.in('status', OPEN_STATUSES);
  if (input.memberId) query = query.eq('member_id', input.memberId);
  const { data, error } = await query;
  if (error) {
    console.error('[service:school] homework read failed', error);
    return fail(describeDbError(error, 'Could not load homework.'), { code: SERVICE_CODES.db });
  }
  return ok(data ?? []);
}

/**
 * Every class row, with NO week-parity filtering — the roster the school and
 * sports front desk matches inbound mail against.
 *
 * `listClasses` is the timetable: it drops a class that does not occur in the
 * requested week, which is right for a planner and wrong here. A teacher's name
 * identifies the child who is in her class whether or not this is an A week,
 * and a message filed against half the roster would link a child on alternate
 * Mondays and no one on the others.
 *
 * Read-only and family-scoped like the rest of this file; the caller gets a
 * `ServiceResult`, so a failed read is a failure and never an empty roster.
 */
export async function listClassRoster(scope: ServiceScope, input: { limit?: number } = {}): Promise<ServiceResult<SchoolClassRow[]>> {
  const { data, error } = await scope.db
    .from('school_classes')
    .select('*')
    .eq('family_id', scope.familyId)
    .order('subject', { ascending: true })
    .limit(Math.min(Math.max(input.limit ?? MAX_ROWS, 1), MAX_ROWS));
  if (error) {
    console.error('[service:school] class roster read failed', error);
    return fail(describeDbError(error, 'Could not load the class roster.'), { code: SERVICE_CODES.db });
  }
  return ok(data ?? []);
}

export type ListClassesInput = {
  memberId?: string | null;
  /** 0 = Sunday … 6 = Saturday. Classes with no day are treated as daily and always included. */
  dayOfWeek?: number | null;
  /** Resolve A/B-week classes for the week containing this instant; defaults to now. */
  forDate?: string | null;
};

/**
 * The timetable, optionally narrowed to one child and one weekday, with A/B
 * week alternation resolved for the requested date so a planner never books
 * an "A week" class in a B week.
 */
export async function listClasses(scope: ServiceScope, input: ListClassesInput = {}): Promise<ServiceResult<SchoolClassRow[]>> {
  if (input.dayOfWeek != null && (!Number.isInteger(input.dayOfWeek) || input.dayOfWeek < 0 || input.dayOfWeek > 6)) {
    return fail('A weekday is a number from 0 (Sunday) to 6 (Saturday).', { code: SERVICE_CODES.invalidInput });
  }
  let query = scope.db
    .from('school_classes')
    .select('*')
    .eq('family_id', scope.familyId)
    .order('day_of_week', { ascending: true, nullsFirst: true })
    .limit(MAX_ROWS);
  if (input.memberId) query = query.eq('member_id', input.memberId);
  const { data, error } = await query;
  if (error) {
    console.error('[service:school] classes read failed', error);
    return fail(describeDbError(error, 'Could not load the school timetable.'), { code: SERVICE_CODES.db });
  }
  const reference = isoOrNull(input.forDate) ?? scopeNow(scope).toISOString();
  const week = weekParity(new Date(reference));
  const rows = (data ?? [])
    .filter((c) => classOccursInWeek(c, week))
    .filter((c) => input.dayOfWeek == null || c.day_of_week === null || c.day_of_week === input.dayOfWeek)
    .sort((a, b) => (a.day_of_week ?? -1) - (b.day_of_week ?? -1) || slotStartMinutes(a.time_slot) - slotStartMinutes(b.time_slot));
  return ok(rows);
}
