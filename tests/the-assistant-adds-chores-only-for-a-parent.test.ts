import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

/**
 * The assistant adds and assigns chores only for a parent or adult — the same
 * rule as the chores board.
 *
 * `createChoreAction` is manager-only; its comment records why ("a child could
 * ... mint chores assigned to a sibling"). The assistant reaches the same
 * writes through `createChore` / `assignChore` (lib/services/tasks), which
 * checked no role, and the gate in front of them does not stand in for one:
 * `riskToDecision` lets a TEEN's low-risk AI writes through, and
 * `tasks.createChore`, `tasks.assignChore` and the chat's `add_chore` are all
 * low risk in a non-sensitive domain. (A family policy allowing Bubaly on
 * chores now speaks only for a parent or adult; the child and caregiver cases
 * below pin that it stays so on these paths.) Nothing in the database narrows
 * `chores` or `chore_assignments` by role.
 *
 * Driven end to end on the in-memory client: the real trust gate, the real
 * registry tools and the real chat wrapper.
 */
const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => holder.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});

const { executeTool } = await import('@/lib/ai/tools/execute');
const { createChore } = await import('@/lib/services/tasks');
const { buildAssistantTools } = await import('@/lib/assistant/tools');
const { wrapToolsWithTrust } = await import('@/lib/assistant/trust-wrapper');

const FAMILY = 'family-1';
const MEMBERS = [
  { id: 'm-parent', user_id: 'u-parent', role: 'parent', display_name: 'Dana' },
  { id: 'm-adult', user_id: 'u-adult', role: 'adult', display_name: 'Chris' },
  { id: 'm-teen', user_id: 'u-teen', role: 'teen', display_name: 'Jules' },
  { id: 'm-child', user_id: 'u-child', role: 'child', display_name: 'Sam' },
  { id: 'm-care', user_id: 'u-care', role: 'caregiver', display_name: 'Pat' },
];
const REFUSED = /parent or another adult/i;

let db: InMemorySupabase;

function member(role: string) {
  const m = MEMBERS.find((x) => x.role === role);
  if (!m) throw new Error(role);
  return m;
}

/** The assistant acting for `role`, as the chat and run executor build it. */
function aiScope(role: string, extra: Partial<ServiceScope> = {}): ServiceScope {
  const m = member(role);
  return {
    db: db as unknown as SupabaseClient<Database>, familyId: FAMILY, userId: m.user_id, memberId: m.id,
    role: role as ServiceScope['role'], actorKind: 'ai', tz: 'UTC', requestId: `req-${role}-${Math.random()}`, ...extra,
  };
}

/** A family that has told Bubaly it may act on chores (Trust → a policy for Bubaly). */
function allowBubalyOnChores() {
  db.seed('trust_policies', [{
    id: 'policy-chores', family_id: FAMILY, name: 'Bubaly may handle chores', domain: 'chores', capability: 'automate',
    subject_kind: 'ai', subject_role: null, subject_member_id: null, effect: 'allow', conditions: {},
    approval_model: 'single', required_approvals: 1, priority: 50, enabled: true, is_system: false,
  }]);
}

function chatTool(role: string, name: string) {
  const m = member(role);
  const tools = wrapToolsWithTrust(
    buildAssistantTools(db as unknown as SupabaseClient<Database>, {
      familyId: FAMILY, userId: m.user_id, memberId: m.id, role, members: MEMBERS.map(({ id, display_name }) => ({ id, display_name })), tz: 'UTC',
    }),
    db as unknown as SupabaseClient<Database>, FAMILY, role, m.id,
  );
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`${name} is not in the chat toolbox`);
  return tool;
}

beforeEach(() => {
  db = createInMemorySupabase({
    defaults: { chores: { requires_approval: true, recurrence: 'none' }, chore_assignments: { status: 'todo' } },
  });
  holder.db = db;
  db.seed('families', [{ id: FAMILY, name: 'Rivera', timezone: 'UTC' }]);
  db.seed('family_members', MEMBERS.map((m) => ({ ...m, family_id: FAMILY, is_active: true })));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('a teen asking Bubaly for a chore', () => {
  it('does not get one created through the registry tool', async () => {
    const out = await executeTool(aiScope('teen'), 'tasks.createChore', { title: 'Do Sam\'s laundry', points: 500, assignee_id: 'm-child' });
    expect(out.status).not.toBe('ok');
    expect(JSON.stringify(out)).toMatch(REFUSED);
    expect(db.table('chores')).toEqual([]);
    expect(db.table('chore_assignments')).toEqual([]);
  });

  it('does not get an existing chore assigned to a sibling', async () => {
    db.seed('chores', [{ id: 'chore-1', family_id: FAMILY, title: 'Bins', points: 10 }]);
    const out = await executeTool(aiScope('teen'), 'tasks.assignChore', { chore_id: 'chore-1', assignee_id: 'm-child' });
    expect(out.status).not.toBe('ok');
    expect(JSON.stringify(out)).toMatch(REFUSED);
    expect(db.table('chore_assignments')).toEqual([]);
  });

  it('does not get one created through the chat\'s add_chore', async () => {
    const res = await chatTool('teen', 'add_chore').execute({ title: 'Do Sam\'s laundry', points: 500, assignee: 'Sam' });
    expect(res).toMatchObject({ ok: false });
    expect(JSON.stringify(res)).toMatch(REFUSED);
    expect(db.table('chores')).toEqual([]);
    expect(db.table('chore_assignments')).toEqual([]);
  });
});

describe('when the family lets Bubaly act on chores', () => {
  beforeEach(allowBubalyOnChores);

  it.each(['child', 'caregiver', 'teen'])('a %s still cannot have a chore created', async (role) => {
    const out = await executeTool(aiScope(role), 'tasks.createChore', { title: 'Mow the lawn', points: 50, assignee_id: 'm-parent' });
    expect(out.status).not.toBe('ok');
    expect(db.table('chores')).toEqual([]);
    const res = await chatTool(role, 'add_chore').execute({ title: 'Mow the lawn', points: 50, assignee: 'Dana' });
    expect(res).toMatchObject({ ok: false });
    expect(db.table('chores')).toEqual([]);
  });

  it.each(['parent', 'adult'])('a %s still has one created and assigned', async (role) => {
    const out = await executeTool(aiScope(role), 'tasks.createChore', { title: 'Bins', points: 10, assignee_id: 'm-child' });
    expect(out.status).toBe('ok');
    expect(db.table('chores')).toHaveLength(1);
    expect(db.table('chore_assignments')).toEqual([expect.objectContaining({ member_id: 'm-child' })]);
    const res = await chatTool(role, 'add_chore').execute({ title: 'Dishes', points: 5, assignee: 'Sam' });
    expect(res).toMatchObject({ ok: true });
    expect(db.table('chores')).toHaveLength(2);
  });
});

describe('the paths that stay open', () => {
  it('a parent\'s assistant assigns an existing chore', async () => {
    db.seed('chores', [{ id: 'chore-1', family_id: FAMILY, title: 'Bins', points: 10 }]);
    const out = await executeTool(aiScope('parent'), 'tasks.assignChore', { chore_id: 'chore-1', assignee_id: 'm-child' });
    expect(out.status).toBe('ok');
    expect(db.table('chore_assignments')).toEqual([expect.objectContaining({ chore_id: 'chore-1', member_id: 'm-child' })]);
  });

  it('a routine running as the system adds a chore', async () => {
    const res = await createChore(
      { db: db as unknown as SupabaseClient<Database>, familyId: FAMILY, userId: null, memberId: null, role: 'system', actorKind: 'system', tz: 'UTC' },
      { title: 'Water the plants', assigneeId: 'm-child' },
    );
    expect(res.ok).toBe(true);
    expect(db.table('chores')).toHaveLength(1);
  });

  it('a child\'s request a parent approved is carried out under the parent\'s role', async () => {
    // scopeForApprovedWork keeps the approver's role and names the asker.
    const res = await createChore(aiScope('parent', { memberId: 'm-child', userId: 'u-child' }), { title: 'Feed the cat', assigneeId: 'm-child' });
    expect(res.ok).toBe(true);
    expect(db.table('chore_assignments')).toEqual([expect.objectContaining({ member_id: 'm-child' })]);
  });

  it('a teen finishing their own repeating chore still gets the next one', async () => {
    // The respawn goes through `assignChore` under the teen's own scope, which
    // is why the manager rule is not applied inside it.
    db.seed('chores', [{ id: 'chore-r', family_id: FAMILY, title: 'Feed the cat', points: 5, requires_approval: false, recurrence: 'daily' }]);
    db.seed('chore_assignments', [{ id: 'a-1', family_id: FAMILY, chore_id: 'chore-r', member_id: 'm-teen', status: 'todo', due_at: '2026-10-10T08:00:00.000Z' }]);
    const out = await executeTool(aiScope('teen'), 'tasks.completeChore', { assignment_id: 'a-1' });
    expect(out.status).toBe('ok');
    const rows = db.table('chore_assignments');
    expect(rows.find((a) => a.id === 'a-1')).toMatchObject({ status: 'done' });
    expect(rows.filter((a) => a.id !== 'a-1')).toEqual([expect.objectContaining({ chore_id: 'chore-r', member_id: 'm-teen', status: 'todo' })]);
  });
});
