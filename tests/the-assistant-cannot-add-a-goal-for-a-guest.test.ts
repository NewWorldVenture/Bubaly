import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAssistantTools, type AssistantCtx } from '@/lib/assistant/tools';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

// 632ce745d made the goals service refuse a guest or a caregiver, but the chat
// toolbox's `add_goal` inserted into `goals` itself. `mergeToolSets` puts that
// hand-written tool in front of the registry's `goals.create`, so the model was
// offered the ungated one, and RLS (`goals_insert using is_family_member`)
// admits every member — a guest could still have a goal written by asking
// Bubaly. The tool now goes through `createGoal` with the caller's role.
type DbArg = Parameters<typeof buildAssistantTools>[0];

const FAMILY = 'fam-1';
let db: InMemorySupabase;

const ctx = (role: string | null): AssistantCtx => ({
  familyId: FAMILY, userId: 'auth-user-1', memberId: 'member-1', role, members: [], tz: 'UTC',
});

async function addGoal(role: string | null, args: Record<string, unknown>) {
  const tool = buildAssistantTools(db as unknown as DbArg, ctx(role)).find((t) => t.name === 'add_goal');
  if (!tool) throw new Error('add_goal is not in the assistant toolbox');
  return tool.execute(args);
}

beforeEach(() => {
  db = createInMemorySupabase();
  db.replace('goals', []);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('assistant add_goal', () => {
  it.each(['guest', 'caregiver'])('refuses a %s and writes nothing', async (role) => {
    const res = await addGoal(role, { title: 'Visit Grandma' });
    expect(res).toEqual({ ok: false, error: 'Only a member of the household can change its goals.' });
    expect(db.table('goals')).toEqual([]);
  });

  it('refuses when the caller role is unknown rather than waving it through', async () => {
    expect(await addGoal(null, { title: 'Visit Grandma' })).toMatchObject({ ok: false });
    expect(await addGoal('stranger', { title: 'Visit Grandma' })).toMatchObject({ ok: false });
    expect(db.table('goals')).toEqual([]);
  });

  it.each(['parent', 'adult', 'teen', 'child'])('still creates the goal for a %s, with the same confirmation', async (role) => {
    const res = await addGoal(role, { title: '  Visit Grandma ', description: 'Summer trip', target_date: '2026-12-01' });
    expect(res).toEqual({ ok: true, summary: 'Created the goal “Visit Grandma”.' });
    expect(db.table('goals')).toHaveLength(1);
    expect(db.table('goals')[0]).toMatchObject({
      family_id: FAMILY, title: 'Visit Grandma', description: 'Summer trip', target_date: '2026-12-01',
      progress: 0, is_complete: false, created_by: 'auth-user-1',
    });
  });

  it('keeps the title-required answer', async () => {
    expect(await addGoal('parent', { title: '  ' })).toEqual({ ok: false, error: 'title is required' });
  });
});
