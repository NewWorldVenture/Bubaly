// "Everyone may do anything on the calendar" — a trust policy with subject
// 'everyone' and capability 'all' — is a rule about what PEOPLE may do. But
// `all` covers `automate`, the capability every AI write is evaluated as, and
// the policy names its domain, so it also silenced the risk tier. A guest's or
// child's assistant then wrote to the family calendar as freely as a parent's,
// a high-risk deletion included. Only a policy addressed to the AI had been
// bounded by the requester's automation trust (AI7/AI12).
//
// The bound now holds whatever the policy's subject: an assistant acting for
// someone not trusted with automation gets no more than the role matrix and
// the risk tier give them. A parent's assistant still gets the policy, and a
// member acting directly is matched exactly as before (the engine cases in
// tests/trust-engine.test.ts). Driven through the real `executeTool`, engine,
// registry and calendar service on the in-memory database.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => holder.db, createServiceClient: () => holder.db }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

const { executeTool } = await import('@/lib/ai/tools/execute');

const FAMILY = '00000000-0000-4000-8000-00000000ac01';
const PEOPLE = {
  parent: { member: '00000000-0000-4000-8000-00000000ac11', user: '00000000-0000-4000-8000-00000000ac21' },
  child: { member: '00000000-0000-4000-8000-00000000ac12', user: '00000000-0000-4000-8000-00000000ac22' },
  guest: { member: '00000000-0000-4000-8000-00000000ac13', user: '00000000-0000-4000-8000-00000000ac23' },
} as const;
type Who = keyof typeof PEOPLE;
const EXISTING_EVENT = '00000000-0000-4000-8000-00000000ac31';
const NOW = new Date('2026-09-05T12:00:00Z');

/** What the Trust form saves for "everyone may do anything on the calendar". */
const EVERYONE_ON_THE_CALENDAR = {
  id: '00000000-0000-4000-8000-00000000ac41', family_id: FAMILY, name: 'Everyone runs the calendar', domain: 'calendar',
  capability: 'all', subject_kind: 'everyone', subject_role: null, subject_member_id: null, effect: 'allow', conditions: {},
  approval_model: 'single', required_approvals: 1, priority: 200, enabled: true, created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
};

let db: InMemorySupabase;

const assistantFor = (who: Who): ServiceScope => ({
  db: db as unknown as SupabaseClient<Database>, familyId: FAMILY, userId: PEOPLE[who].user, memberId: PEOPLE[who].member,
  role: who, actorKind: 'ai', tz: 'America/New_York', now: NOW,
});

beforeEach(() => {
  db = createInMemorySupabase({
    uniques: { ai_tool_calls: [['family_id', 'idempotency_key']] },
    defaults: {
      ai_tool_calls: { state: 'reserved', attempt: 1, outputs: null, error: null, finished_at: null },
      approval_requests: { approvals: [], edited_payload: null, plan_step_ids: [] },
    },
  });
  holder.db = db;
  db.seed('families', [{ id: FAMILY, name: 'The Riveras', timezone: 'America/New_York' }]);
  db.seed('family_members', (Object.keys(PEOPLE) as Who[]).map((role) => ({
    id: PEOPLE[role].member, family_id: FAMILY, user_id: PEOPLE[role].user, role, is_active: true, display_name: role,
  })));
  db.seed('family_ai_settings', [{ family_id: FAMILY, enabled: true, behavior: 'execute' }]);
  db.seed('trust_policies', [EVERYONE_ON_THE_CALENDAR]);
  db.seed('calendar_events', [{
    id: EXISTING_EVENT, family_id: FAMILY, title: 'Grandma visits', starts_at: '2026-09-12T14:00:00Z', ends_at: '2026-09-12T18:00:00Z',
    all_day: false, category: 'family', created_by: PEOPLE.parent.user, deleted_at: null,
  }]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

const ADD_PARTY = { title: 'Sleepover party', starts_at: '2026-09-19T18:00:00', ends_at: '2026-09-19T22:00:00' };
const created = () => db.table('calendar_events').filter((e) => e.title === ADD_PARTY.title);
const grandma = () => db.table('calendar_events').find((e) => e.id === EXISTING_EVENT);

describe('an allow for everyone does not make a guest’s or child’s assistant an autopilot', () => {
  it.each(['guest', 'child'] as const)('refuses a %s’s assistant a calendar write the role itself is not trusted to automate', async (who) => {
    const outcome = await executeTool(assistantFor(who), 'calendar.createEvent', ADD_PARTY);

    expect(outcome.status).toBe('denied');
    expect(created()).toEqual([]);
    expect(db.table('ai_tool_calls')).toEqual([]);
  });

  it('does not let a child’s assistant delete an event with the risk tier silenced — a person decides', async () => {
    const outcome = await executeTool(assistantFor('child'), 'calendar.deleteEvent', { event_id: EXISTING_EVENT });

    expect(outcome.status).not.toBe('ok');
    expect(grandma()).toMatchObject({ title: 'Grandma visits', deleted_at: null });
    expect(db.table('ai_tool_calls')).toEqual([]);
  });

  it('still lets a parent’s assistant do what the family allowed', async () => {
    const outcome = await executeTool(assistantFor('parent'), 'calendar.createEvent', ADD_PARTY);

    expect(outcome).toMatchObject({ status: 'ok' });
    expect(created()).toHaveLength(1);
    expect(created()[0]).toMatchObject({ family_id: FAMILY });
  });
});
