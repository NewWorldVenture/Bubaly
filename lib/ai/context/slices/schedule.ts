// The coming week on the calendar, the routines that shape every day, the
// double-bookings already present, and the timing constraints the family has
// told Bubaly about ("nothing before 9 on Saturday"). All windows are the
// family's local week (`env.weekFromIso..weekToIso`), never the server's.
import 'server-only';
import { fenceUntrusted, sanitizeUntrusted } from '@/lib/ai/safety/untrusted';
import { findConflicts, searchEvents } from '@/lib/services/calendar';
import { recallFacts } from '@/lib/services/memory';
import { fail, ok, SERVICE_CODES } from '@/lib/services/types';
import { describeDbError } from '@/lib/supabase/errors';
import { memberName, type SliceDefinition } from '../policy';
import { day, weekdays, when } from '../render';

const MAX_EVENTS = 40;
const MAX_ROUTINES = 20;
const MAX_CONSTRAINTS = 10;

/** A preference fact is a scheduling constraint when it talks about time. */
const CONSTRAINT_RE = /\b(before|after|no earlier|no later|not before|not after|bedtime|nap|quiet|weekend|morning|evening|night|schedule|screen ?time|curfew|early|late|o'?clock|\d{1,2}\s?(am|pm))\b/i;

export type ScheduleSliceData = {
  window: { from: string; to: string };
  events: { id: string; title: string; startsAt: string; endsAt: string | null; allDay: boolean; category: string; assignee: string | null; location: string | null }[];
  conflicts: { assignee: string | null; startsAt: string; titles: string[] }[];
  routines: { id: string; title: string; timeOfDay: string | null; days: number[]; member: string | null }[];
  constraints: { label: string; value: string; member: string | null }[];
};

export const scheduleSlice: SliceDefinition = {
  name: 'schedule',
  title: 'Schedule (next 7 days)',
  async load(scope, env) {
    const window = { from: env.weekFromIso, to: env.weekToIso };
    const [events, conflicts, facts, routines] = await Promise.all([
      searchEvents(scope, { from: window.from, to: window.to, limit: MAX_EVENTS }),
      findConflicts(scope, window),
      recallFacts(scope, { category: 'preference', limit: 200 }),
      scope.db
        .from('family_routines')
        .select('id, title, time_of_day, days_of_week, member_id')
        .eq('family_id', scope.familyId)
        .eq('status', 'active')
        .is('deleted_at', null)
        .order('time_of_day', { ascending: true, nullsFirst: false })
        .limit(MAX_ROUTINES),
    ]);
    if (!events.ok) return events;
    if (!conflicts.ok) return conflicts;
    if (!facts.ok) return facts;
    if (routines.error) {
      console.error('[ai-context:schedule] routines read failed', routines.error);
      return fail(describeDbError(routines.error, 'Could not load the family routines.'), { code: SERVICE_CODES.db });
    }

    const data: ScheduleSliceData = {
      window,
      events: events.data.map((e) => ({
        id: e.id, title: e.title, startsAt: e.starts_at, endsAt: e.ends_at, allDay: e.all_day, category: e.category,
        assignee: memberName(env, e.assignee_id), location: e.location,
      })),
      conflicts: conflicts.data.conflicts.map((c) => ({
        assignee: memberName(env, c.assigneeId),
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

    const lines: string[] = [];
    for (const c of data.conflicts) {
      const who = c.assignee ?? 'someone';
      lines.push(`- CONFLICT ${when(c.startsAt, env.tz, env.now)}: ${who} has ${c.titles.map((t) => fenceUntrusted('event_title', t)).join(' and ')} overlapping`);
    }
    for (const e of data.events) {
      const time = e.allDay ? `${day(e.startsAt, env.tz, env.now)} (all day)` : when(e.startsAt, env.tz, env.now);
      const bits = [`- ${time}: ${fenceUntrusted('event_title', e.title)}`];
      if (e.assignee) bits.push(`for ${e.assignee}`);
      if (e.location) bits.push(`at ${fenceUntrusted('event_location', e.location)}`);
      if (e.category && e.category !== 'other') bits.push(`[${e.category}]`);
      lines.push(bits.join(' '));
    }
    if (data.events.length === 0) lines.push('- Nothing on the calendar in the next 7 days.');
    for (const r of data.routines) {
      const bits = [`- Routine: ${fenceUntrusted('routine', r.title)}`, weekdays(r.days)];
      if (r.timeOfDay) bits.push(`at ${sanitizeUntrusted(r.timeOfDay, 20)}`);
      if (r.member) bits.push(`(${r.member})`);
      lines.push(bits.join(' '));
    }
    for (const c of data.constraints) {
      lines.push(`- Constraint${c.member ? ` for ${c.member}` : ''}: ${fenceUntrusted('fact', `${c.label}: ${c.value}`)}`);
    }

    return ok({ data, count: data.events.length + data.routines.length + data.conflicts.length, lines });
  },
};
