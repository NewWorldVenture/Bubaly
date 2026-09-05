// Sports tools: teams and the practices/games that fill a family's evenings.
// Read-only. `education` in the trust taxonomy because `TRUST_DOMAINS` has no
// sports domain and these reads exist for the same school-week planning.
// Recurring practices are expanded by the service, so a weekly practice shows
// up every week it happens.
import 'server-only';
import { z } from 'zod';
import { scopeNow } from '@/lib/services/scope';
import { listPracticesBetween, listTeams } from '@/lib/services/sports';
import { ok } from '@/lib/services/types';
import { resolveAssigneeId } from './family';
import { defineTool, describeWhen, plural, type ToolDefinition } from './types';

const memberInput = {
  member: z.string().nullish().describe('Family member name'),
  member_id: z.string().nullish(),
};

export const sportsTools: ToolDefinition[] = [
  defineTool({
    name: 'sports.listTeams',
    aliases: ['list_teams', 'sports_teams'],
    description: 'The teams family members play on. Active teams only unless asked otherwise.',
    domain: 'education',
    capability: 'view',
    risk: 'low',
    readOnly: true,
    input: z.object({ include_inactive: z.boolean().nullish(), ...memberInput }),
    output: z.object({
      teams: z.array(z.object({ id: z.string(), sport: z.string(), team_name: z.string(), season: z.string().nullable(), coach: z.string().nullable(), is_active: z.boolean(), member_id: z.string().nullable() })),
    }),
    summarize: (_input, output) => (output.teams.length === 0 ? 'No teams on record' : `${plural(output.teams.length, 'team')}: ${output.teams.map((t) => t.team_name).join(', ')}`),
    execute: async (scope, input) => {
      const member = await resolveAssigneeId(scope, { assignee: input.member, assignee_id: input.member_id });
      if (!member.ok) return member;
      const res = await listTeams(scope, { memberId: member.data, activeOnly: !(input.include_inactive ?? false) });
      if (!res.ok) return res;
      return ok({ teams: res.data.map((t) => ({ id: t.id, sport: t.sport, team_name: t.team_name, season: t.season, coach: t.coach, is_active: t.is_active, member_id: t.member_id })) });
    },
  }),

  defineTool({
    name: 'sports.listPracticesBetween',
    aliases: ['list_practices', 'sports_events_between'],
    description: 'Practices, games and tournaments in a window, weekly series expanded, soonest first. Defaults to the coming week.',
    domain: 'education',
    capability: 'view',
    risk: 'low',
    readOnly: true,
    input: z.object({
      from: z.string().nullish().describe('ISO 8601'),
      to: z.string().nullish().describe('ISO 8601'),
      event_type: z.string().nullish().describe('practice, game or tournament'),
      ...memberInput,
    }),
    output: z.object({
      events: z.array(z.object({
        id: z.string(), title: z.string(), sport: z.string().nullable(), team: z.string().nullable(), event_type: z.string().nullable(),
        location: z.string().nullable(), starts_at: z.string(), ends_at: z.string().nullable(), when: z.string(), member_id: z.string().nullable(),
      })),
    }),
    summarize: (_input, output) => (output.events.length === 0
      ? 'No practices or games in that window'
      : `${plural(output.events.length, 'sports event')}, starting with ${output.events[0].title} ${output.events[0].when}`),
    execute: async (scope, input) => {
      const member = await resolveAssigneeId(scope, { assignee: input.member, assignee_id: input.member_id });
      if (!member.ok) return member;
      const res = await listPracticesBetween(scope, { from: input.from ?? null, to: input.to ?? null, memberId: member.data, eventType: input.event_type ?? null });
      if (!res.ok) return res;
      const now = scopeNow(scope);
      return ok({
        events: res.data.map((e) => ({
          id: e.id, title: e.title, sport: e.sport, team: e.team, event_type: e.event_type, location: e.location,
          starts_at: e.starts_at, ends_at: e.ends_at, when: describeWhen(e.starts_at, scope.tz, now), member_id: e.member_id,
        })),
      });
    },
  }),
];
