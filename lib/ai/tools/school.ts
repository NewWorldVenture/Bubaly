// School tools: the events, homework and timetable a week plan has to
// respect. All read-only, all `education`. Member names are resolved through
// the shared roster resolver so "Ava's homework" and "member_id: …" land on
// the same rows.
import 'server-only';
import { z } from 'zod';
import { listClasses, listEventsBetween, listHomeworkDue } from '@/lib/services/school';
import { scopeNow } from '@/lib/services/scope';
import { ok } from '@/lib/services/types';
import { resolveAssigneeId } from './family';
import { defineTool, describeWhen, plural, type ToolDefinition } from './types';

const memberInput = {
  member: z.string().nullish().describe('Family member name'),
  member_id: z.string().nullish(),
};

export const schoolTools: ToolDefinition[] = [
  defineTool({
    name: 'school.listEventsBetween',
    aliases: ['list_school_events', 'school_events_between'],
    description: 'School events (holidays, field trips, parent meetings, exams) in a window, soonest first. Defaults to the coming week.',
    domain: 'education',
    capability: 'view',
    risk: 'low',
    readOnly: true,
    input: z.object({ from: z.string().nullish().describe('ISO 8601'), to: z.string().nullish().describe('ISO 8601'), ...memberInput }),
    output: z.object({
      events: z.array(z.object({
        id: z.string(), title: z.string(), event_type: z.string().nullable(), school_name: z.string().nullable(),
        starts_at: z.string(), ends_at: z.string().nullable(), when: z.string(), member_id: z.string().nullable(),
      })),
    }),
    summarize: (_input, output) => (output.events.length === 0
      ? 'No school events in that window'
      : `${plural(output.events.length, 'school event')}, starting with ${output.events[0].title} ${output.events[0].when}`),
    execute: async (scope, input) => {
      const member = await resolveAssigneeId(scope, { assignee: input.member, assignee_id: input.member_id });
      if (!member.ok) return member;
      const res = await listEventsBetween(scope, { from: input.from ?? null, to: input.to ?? null, memberId: member.data });
      if (!res.ok) return res;
      const now = scopeNow(scope);
      return ok({
        events: res.data.map((e) => ({
          id: e.id, title: e.title, event_type: e.event_type, school_name: e.school_name, starts_at: e.starts_at, ends_at: e.ends_at,
          when: describeWhen(e.starts_at, scope.tz, now), member_id: e.member_id,
        })),
      });
    },
  }),

  defineTool({
    name: 'school.listHomeworkDue',
    aliases: ['list_homework', 'homework_due'],
    description: 'Homework still to do that is due in a window, soonest first. Defaults to the coming week.',
    domain: 'education',
    capability: 'view',
    risk: 'low',
    readOnly: true,
    input: z.object({
      from: z.string().nullish().describe('ISO 8601'),
      to: z.string().nullish().describe('ISO 8601'),
      include_done: z.boolean().nullish(),
      ...memberInput,
    }),
    output: z.object({
      homework: z.array(z.object({
        id: z.string(), title: z.string(), subject: z.string().nullable(), due_at: z.string().nullable(), when: z.string(), status: z.string(), member_id: z.string().nullable(),
      })),
    }),
    summarize: (_input, output) => (output.homework.length === 0
      ? 'No homework due in that window'
      : `${plural(output.homework.length, 'homework assignment')} due; first is ${output.homework[0].title} ${output.homework[0].when}`),
    execute: async (scope, input) => {
      const member = await resolveAssigneeId(scope, { assignee: input.member, assignee_id: input.member_id });
      if (!member.ok) return member;
      const res = await listHomeworkDue(scope, { from: input.from ?? null, to: input.to ?? null, memberId: member.data, includeDone: input.include_done ?? false });
      if (!res.ok) return res;
      const now = scopeNow(scope);
      return ok({
        homework: res.data.map((h) => ({
          id: h.id, title: h.title, subject: h.subject, due_at: h.due_at, when: describeWhen(h.due_at, scope.tz, now), status: h.status, member_id: h.member_id,
        })),
      });
    },
  }),

  defineTool({
    name: 'school.listClasses',
    aliases: ['list_school_classes', 'school_timetable'],
    description: 'The school timetable, optionally for one child and one weekday, with A/B-week alternation already resolved.',
    domain: 'education',
    capability: 'view',
    risk: 'low',
    readOnly: true,
    input: z.object({
      day_of_week: z.number().int().nullish().describe('0 = Sunday … 6 = Saturday'),
      for_date: z.string().nullish().describe('ISO 8601 date inside the week to resolve A/B classes for; defaults to now'),
      ...memberInput,
    }),
    output: z.object({
      classes: z.array(z.object({
        id: z.string(), subject: z.string(), teacher: z.string().nullable(), room: z.string().nullable(), time_slot: z.string().nullable(),
        day_of_week: z.number().int().nullable(), week_pattern: z.string(), member_id: z.string(),
      })),
    }),
    summarize: (_input, output) => (output.classes.length === 0 ? 'No classes on the timetable' : `${plural(output.classes.length, 'class', 'classes')} on the timetable`),
    execute: async (scope, input) => {
      const member = await resolveAssigneeId(scope, { assignee: input.member, assignee_id: input.member_id });
      if (!member.ok) return member;
      const res = await listClasses(scope, { memberId: member.data, dayOfWeek: input.day_of_week ?? null, forDate: input.for_date ?? null });
      if (!res.ok) return res;
      return ok({
        classes: res.data.map((c) => ({
          id: c.id, subject: c.subject, teacher: c.teacher, room: c.room, time_slot: c.time_slot, day_of_week: c.day_of_week, week_pattern: c.week_pattern, member_id: c.member_id,
        })),
      });
    },
  }),
];
