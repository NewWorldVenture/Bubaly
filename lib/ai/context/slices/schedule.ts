// The coming week on the calendar, the routines that shape every day, the
// double-bookings already present, and the timing constraints the family has
// told Bubaly about ("nothing before 9 on Saturday"). All windows are the
// family's local week (`env.weekFromIso..weekToIso`), never the server's.
import 'server-only';
import { fenceUntrusted, sanitizeUntrusted } from '@/lib/ai/safety/untrusted';
import { findConflicts } from '@/lib/services/calendar';
import { searchCalendarOccurrences, validateCalendarSearchWindow, type NativeSearchOccurrence, type SourceSearchOccurrence, type SearchCalendarOccurrencesResult } from '@/lib/services/calendar/search-occurrences';
import type { CalendarConflictAdvisory, CalendarConflictSubject } from '@/lib/calendar/conflict-advisories';
import { recallFactsForContext } from '../recall';
import { fail, ok, SERVICE_CODES } from '@/lib/services/types';
import { describeDbError } from '@/lib/supabase/errors';
import { settle } from '@/lib/supabase/settle';
import { memberName, type SliceDefinition } from '../policy';
import { dayKeyLabel, weekdays, when } from '../render';

const MAX_EVENTS = 40;
const MAX_ROUTINES = 20;
const MAX_CONSTRAINTS = 10;

/** A preference fact is a scheduling constraint when it talks about time. */
const CONSTRAINT_RE = /\b(before|after|no earlier|no later|not before|not after|bedtime|nap|quiet|weekend|morning|evening|night|schedule|screen ?time|curfew|early|late|o'?clock|\d{1,2}\s?(am|pm))\b/i;

export type ScheduleSliceData = {
  window: { from: string; to: string };
  events: (Pick<NativeSearchOccurrence, 'id' | 'kind' | 'eventId' | 'title' | 'description' | 'location' | 'category'
    | 'starts_at' | 'ends_at' | 'all_day' | 'actualStartsAt' | 'actualEndsAt' | 'startDate' | 'endDate'
    | 'reference' | 'occurrenceKey' | 'transparency' | 'occupied' | 'point' | 'estimatedEnd' | 'interval'
    | 'displayOrder' | 'readOnly' | 'mutable' | 'feed_id' | 'external_uid'> & { startsAt: string; endsAt: string | null; allDay: boolean; assignee: string | null })[];
  source_events: SourceSearchOccurrence[];
  search: Pick<SearchCalendarOccurrencesResult, 'totalVisibleCount' | 'matchedCount' | 'returnedCount' | 'truncated' | 'horizonEndsAt' | 'filterScope'>;
  advisories: CalendarConflictAdvisory[];
  subjects: Record<string, CalendarConflictSubject>;
  conflicts: { assignee: string | null; startsAt: string; titles: string[]; eventIds: string[]; occurrenceKeys: string[]; subjects: CalendarConflictSubject[] }[];
  routines: { id: string; title: string; timeOfDay: string | null; days: number[]; member: string | null }[];
  constraints: { label: string; value: string; member: string | null }[];
};

type ScheduleSubject = CalendarConflictSubject | NativeSearchOccurrence | SourceSearchOccurrence;
function subjectIdentity(subject: ScheduleSubject): string {
  const ref = subject.reference;
  return ref.kind === 'native' ? JSON.stringify(['native', ref.eventId, subject.occurrenceKey])
    : JSON.stringify(['source', ref.feedId, ref.uid, ref.original.kind, ref.original.value,
      ref.original.kind === 'zoned' ? ref.original.tzid : null]);
}
function subjectSignature(subject: ScheduleSubject): string {
  const ref = subject.reference;
  return JSON.stringify([subjectIdentity(subject), subject.occurrenceKey, subject.title, subject.actualStartsAt,
    subject.actualEndsAt, subject.readOnly, subject.mutable, ref.kind === 'source' ? ref.revisionId : null]);
}

export const scheduleSlice: SliceDefinition = {
  name: 'schedule',
  title: 'Schedule (next 7 days)',
  async load(scope, env) {
    const window = { from: env.weekFromIso, to: env.weekToIso };
    try { validateCalendarSearchWindow(scope, window); }
    catch { return fail('That calendar window could not be understood.', { code: SERVICE_CODES.invalidInput }); }
    const [events, conflicts, facts, routines] = await Promise.all([
      searchCalendarOccurrences(scope, { from: window.from, to: window.to, limit: MAX_EVENTS }),
      findConflicts(scope, window),
      recallFactsForContext(scope, { category: 'preference', limit: 200 }),
      settle(scope.db
        .from('family_routines')
        .select('id, title, time_of_day, days_of_week, member_id')
        .eq('family_id', scope.familyId)
        .eq('status', 'active')
        .is('deleted_at', null)
        .order('time_of_day', { ascending: true, nullsFirst: false })
        .limit(MAX_ROUTINES)),
  ]);
    if (!events.ok) return events;
    if (!conflicts.ok) return conflicts;
    if (!facts.ok) return facts;
    if (routines.error) {
      console.error('[ai-context:schedule] routines read failed', routines.error);
      return fail(describeDbError(routines.error, 'Could not load the family routines.'), { code: SERVICE_CODES.db });
    }

    // These are separate qualified reads, not a transaction. Refuse a visible
    // occurrence that contradicts the warning read, without collapsing repeated
    // native action IDs or tying source identity to a materialization revision.
    const warningSubjects = new Map<string, CalendarConflictSubject>();
    for (const subject of [...Object.values(conflicts.data.subjects), ...conflicts.data.advisories.flatMap(a => a.subjects)]) {
      const identity = subjectIdentity(subject), previous = warningSubjects.get(identity);
      if (previous && subjectSignature(previous) !== subjectSignature(subject)) {
        return fail('Could not load a consistent calendar. Please refresh and try again.', { code: SERVICE_CODES.db });
      }
      warningSubjects.set(identity, subject);
    }
    for (const occurrence of [...events.data.events, ...events.data.source_events]) {
      const subject = warningSubjects.get(subjectIdentity(occurrence));
      if (occurrence.kind === 'native' && !subject || subject && subjectSignature(subject) !== subjectSignature(occurrence)) {
        return fail('Could not load a consistent calendar. Please refresh and try again.', { code: SERVICE_CODES.db });
      }
    }

    const data: ScheduleSliceData = {
      window,
      events: events.data.events.map((e) => ({
        id: e.id, kind: e.kind, eventId: e.eventId, title: e.title, description: e.description, location: e.location, category: e.category,
        starts_at: e.starts_at, ends_at: e.ends_at, all_day: e.all_day, actualStartsAt: e.actualStartsAt, actualEndsAt: e.actualEndsAt,
        startDate: e.startDate, endDate: e.endDate, reference: e.reference, occurrenceKey: e.occurrenceKey, transparency: e.transparency,
        occupied: e.occupied, point: e.point, estimatedEnd: e.estimatedEnd, interval: e.interval, displayOrder: e.displayOrder,
        readOnly: e.readOnly, mutable: e.mutable, feed_id: e.feed_id, external_uid: e.external_uid,
        startsAt: e.starts_at, endsAt: e.ends_at, allDay: e.all_day, assignee: memberName(env, e.assignee_id),
      })),
      source_events: events.data.source_events,
      search: { totalVisibleCount: events.data.totalVisibleCount, matchedCount: events.data.matchedCount,
        returnedCount: events.data.returnedCount, truncated: events.data.truncated,
        horizonEndsAt: events.data.horizonEndsAt, filterScope: events.data.filterScope },
      advisories: conflicts.data.advisories,
      subjects: conflicts.data.subjects,
      conflicts: conflicts.data.conflicts.map((c) => ({
        assignee: memberName(env, c.assigneeId),
        eventIds: c.eventIds, occurrenceKeys: c.occurrenceKeys ?? [],
        subjects: (c.occurrenceKeys ?? []).map(key => conflicts.data.subjects[key]),
        startsAt: c.startsAt,
        titles: c.eventIds.map((id) => conflicts.data.events[id]?.title).filter((t): t is string => Boolean(t)),
      })),
      routines: (routines.data ?? []).map((r) => ({
        id: r.id, title: r.title, timeOfDay: r.time_of_day, days: r.days_of_week ?? [], member: memberName(env, r.member_id),
      })),
      constraints: facts.data
        .filter((f) => CONSTRAINT_RE.test(`${f.label} ${f.value}`))
        .slice(0, MAX_CONSTRAINTS)
        .map((f) => ({ label: f.label, value: f.value, member: memberName(env, f.member_id) })),
    };

    // Compact safety/count summary comes before any bounded untrusted text.
    const lines: string[] = [`- Calendar: ${data.search.returnedCount} shown of ${data.search.matchedCount} matched / ${data.search.totalVisibleCount} total; ${data.conflicts.length} personal conflicts; ${data.advisories.length} family overlap advisories. ${data.search.truncated ? 'Display truncated. ' : ''}Warnings include events outside the display cap. Free/point annotations do not occupy time.`];
    for (const c of data.conflicts) {
      const who = c.assignee ?? 'someone';
      lines.push(`- CONFLICT ${when(c.startsAt, env.tz, env.now)}: ${who} has ${c.titles.map((t) => fenceUntrusted('event_title', t)).join(' and ')} overlapping`);
    }
    for (const advisory of data.advisories) {
      lines.push(`- FAMILY OVERLAP ADVISORY ${when(advisory.startsAt, env.tz, env.now)}: ${advisory.subjects.map(subject => fenceUntrusted('event_title', subject.title ?? 'Calendar event')).join(' and ')}; conservative family occupancy, source person/category unmapped; no personal clash or source edit inferred.`);
    }
    const ordered = [...data.events, ...data.source_events].sort((a, b) => a.displayOrder - b.displayOrder);
    for (const e of ordered) {
      const time = e.all_day
        ? `${dayKeyLabel(e.startDate)} (all day; civil ${e.startDate} to ${e.endDate} exclusive)`
        : when(e.actualStartsAt, env.tz, env.now);
      const bits = [`- ${time}: ${fenceUntrusted('event_title', e.title ?? 'Calendar event')}`];
      if (e.kind === 'native' && e.assignee) bits.push(`for ${e.assignee}`);
      if (e.location) bits.push(`at ${fenceUntrusted('event_location', e.location)}`);
      if (e.description) bits.push(fenceUntrusted('event_description', e.description));
      if (e.kind === 'native' && e.category && e.category !== 'other') bits.push(`[${e.category}]`);
      if (e.kind === 'source') bits.push('[read-only source; family context; person/category unmapped]');
      else if (e.readOnly) bits.push('[read-only imported native copy]');
      if (!e.occupied) bits.push(e.point ? '[point annotation; does not occupy time]' : '[free annotation; does not occupy time]');
      if (e.estimatedEnd) bits.push('[end estimated at one hour]');
      lines.push(bits.join(' '));
    }
    if (data.search.totalVisibleCount === 0 && data.conflicts.length === 0 && data.advisories.length === 0) {
      lines.push('- Nothing on the calendar in the next 7 days.');
    }
    for (const r of data.routines) {
      const bits = [`- Routine: ${fenceUntrusted('routine', r.title)}`, weekdays(r.days)];
      if (r.timeOfDay) bits.push(`at ${sanitizeUntrusted(r.timeOfDay, 20)}`);
      if (r.member) bits.push(`(${r.member})`);
      lines.push(bits.join(' '));
    }
    for (const c of data.constraints) {
      lines.push(`- Constraint${c.member ? ` for ${c.member}` : ''}: ${fenceUntrusted('fact', `${c.label}: ${c.value}`)}`);
    }

    return ok({ data, count: data.search.returnedCount + data.routines.length + data.conflicts.length + data.advisories.length, lines });
  },
};
