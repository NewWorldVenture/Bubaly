// School and sports for the coming week: the standing classes, the school
// events and homework due, the teams and their practices and games. This is
// what turns "Tuesday" into "Tuesday, when Maya has practice until 6".
import 'server-only';
import { fenceUntrusted, sanitizeUntrusted } from '@/lib/ai/safety/untrusted';
import { listClasses, listEventsBetween, listHomeworkDue } from '@/lib/services/school';
import { listPracticesBetween, listTeams } from '@/lib/services/sports';
import { ok } from '@/lib/services/types';
import { memberName, type SliceDefinition } from '../policy';
import { weekdays, when } from '../render';

const MAX_CLASSES = 30;
const MAX_ROWS = 25;

export type ActivitiesSliceData = {
  classes: { subject: string; member: string | null; dayOfWeek: number | null; timeSlot: string | null; school: string | null }[];
  schoolEvents: { id: string; title: string; startsAt: string; member: string | null; type: string | null }[];
  homework: { id: string; title: string; subject: string | null; dueAt: string | null; member: string | null; status: string }[];
  teams: { id: string; teamName: string; sport: string; member: string | null; season: string | null }[];
  practices: { id: string; title: string; startsAt: string; endsAt: string | null; type: string | null; member: string | null; location: string | null }[];
};

export const activitiesSlice: SliceDefinition = {
  name: 'activities',
  title: 'School and sports (next 7 days)',
  async load(scope, env) {
    const window = { from: env.weekFromIso, to: env.weekToIso };
    const [classes, schoolEvents, homework, teams, practices] = await Promise.all([
      listClasses(scope, { forDate: env.now.toISOString() }),
      listEventsBetween(scope, { ...window, limit: MAX_ROWS }),
      listHomeworkDue(scope, { ...window, limit: MAX_ROWS }),
      listTeams(scope, { activeOnly: true }),
      listPracticesBetween(scope, { ...window, limit: MAX_ROWS }),
    ]);
    if (!classes.ok) return classes;
    if (!schoolEvents.ok) return schoolEvents;
    if (!homework.ok) return homework;
    if (!teams.ok) return teams;
    if (!practices.ok) return practices;

    const data: ActivitiesSliceData = {
      classes: classes.data.slice(0, MAX_CLASSES).map((c) => ({
        subject: c.subject, member: memberName(env, c.member_id), dayOfWeek: c.day_of_week, timeSlot: c.time_slot, school: c.school_name,
      })),
      schoolEvents: schoolEvents.data.map((e) => ({ id: e.id, title: e.title, startsAt: e.starts_at, member: memberName(env, e.member_id), type: e.event_type })),
      homework: homework.data.map((h) => ({ id: h.id, title: h.title, subject: h.subject, dueAt: h.due_at, member: memberName(env, h.member_id), status: h.status })),
      teams: teams.data.map((t) => ({ id: t.id, teamName: t.team_name, sport: t.sport, member: memberName(env, t.member_id), season: t.season })),
      practices: practices.data.slice(0, MAX_ROWS).map((p) => ({
        id: p.id, title: p.title, startsAt: p.starts_at, endsAt: p.ends_at, type: p.event_type, member: memberName(env, p.member_id), location: p.location,
      })),
    };

    const lines: string[] = [];
    for (const p of data.practices) {
      const bits = [`- ${when(p.startsAt, env.tz, env.now)}: ${fenceUntrusted('sports_event', p.title)}`];
      if (p.type) bits.push(`(${sanitizeUntrusted(p.type, 20)})`);
      if (p.member) bits.push(`for ${p.member}`);
      if (p.location) bits.push(`at ${fenceUntrusted('location', p.location)}`);
      lines.push(bits.join(' '));
    }
    for (const e of data.schoolEvents) {
      const bits = [`- ${when(e.startsAt, env.tz, env.now)}: ${fenceUntrusted('school_event', e.title)}`];
      if (e.member) bits.push(`for ${e.member}`);
      lines.push(bits.join(' '));
    }
    for (const h of data.homework) {
      const bits = [`- Homework due ${when(h.dueAt, env.tz, env.now)}: ${fenceUntrusted('homework', h.title)}`];
      if (h.subject) bits.push(`(${fenceUntrusted('subject', h.subject)})`);
      if (h.member) bits.push(`for ${h.member}`);
      lines.push(bits.join(' '));
    }
    for (const t of data.teams) {
      lines.push(`- Team: ${fenceUntrusted('team', t.teamName)} (${sanitizeUntrusted(t.sport, 30)})${t.member ? ` — ${t.member}` : ''}`);
    }
    for (const c of data.classes) {
      const bits = [`- Class: ${fenceUntrusted('class', c.subject)}`];
      if (c.member) bits.push(`for ${c.member}`);
      if (c.dayOfWeek !== null) bits.push(weekdays([c.dayOfWeek]));
      if (c.timeSlot) bits.push(sanitizeUntrusted(c.timeSlot, 30));
      lines.push(bits.join(' '));
    }

    const count = data.classes.length + data.schoolEvents.length + data.homework.length + data.teams.length + data.practices.length;
    return ok({ data, count, lines });
  },
};
