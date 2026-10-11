import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteGoalAction, saveGoalAction, setGoalProgressAction } from '@/app/(app)/dashboard/goals/actions';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

// A family goal is the household's. Nothing between a signed-in member and the
// delete looked at the role: the page gate checks plan entitlement only, the
// action built a scope and called the service, the service filtered on id and
// family_id, and RLS (`goals_delete using is_family_member`) admits every active
// member. So a guest ("view limited shared events only") could remove the
// family's goals by POSTing the action with any goal id from their family.
//
// The service now decides: a goal is removed by a parent or adult (as savings
// goals and budgets are), and changed by anyone but a guest or a caregiver.
// RLS still admits every member, so the policy change is reported, not written.
const mocks = vi.hoisted(() => ({ createServer: vi.fn(), requireUserContext: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const FAMILY = 'fam-1';
const GOAL = { id: 'goal-1', family_id: FAMILY, title: 'Visit Grandma', progress: 10, is_complete: false };
let db: InMemorySupabase;

function asRole(role: string) {
  mocks.requireUserContext.mockResolvedValue({
    user: { id: 'auth-user-1' },
    active: { familyId: FAMILY, role, member: { id: 'member-1' }, family: { id: FAMILY, timezone: 'UTC' } },
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  db = createInMemorySupabase();
  db.replace('goals', [{ ...GOAL }]);
  mocks.createServer.mockResolvedValue(db);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('deleteGoalAction', () => {
  it.each(['guest', 'caregiver', 'child', 'teen'])('refuses a %s and leaves the goal in place', async (role) => {
    asRole(role);
    const res = await deleteGoalAction(GOAL.id);
    expect(res).toEqual({ ok: false, error: 'Only a parent or another adult can remove a family goal.' });
    expect(db.table('goals')).toEqual([GOAL]);
    expect(db.log).toEqual([]);
  });

  it.each(['parent', 'adult'])('lets a %s remove the goal', async (role) => {
    asRole(role);
    expect(await deleteGoalAction(GOAL.id)).toEqual({ ok: true, id: GOAL.id });
    expect(db.table('goals')).toEqual([]);
  });
});

describe('the other goal writes', () => {
  it.each(['guest', 'caregiver'])('refuses a %s creating, editing or moving a goal', async (role) => {
    asRole(role);
    const refused = { ok: false, error: 'Only a member of the household can change its goals.' };
    expect(await saveGoalAction(null, { title: 'New goal' })).toEqual(refused);
    expect(await saveGoalAction(GOAL.id, { title: 'Renamed' })).toEqual(refused);
    expect(await setGoalProgressAction(GOAL.id, 100)).toEqual(refused);
    expect(db.table('goals')).toEqual([GOAL]);
    expect(db.log).toEqual([]);
  });

  it.each(['child', 'teen'])('still lets a %s move a goal forward', async (role) => {
    asRole(role);
    expect(await setGoalProgressAction(GOAL.id, 50)).toEqual({ ok: true, id: GOAL.id });
    expect(db.table('goals')[0]).toMatchObject({ progress: 50, is_complete: false });
  });
});

describe('goals-module', () => {
  it('offers the delete button only to a role the service lets delete', () => {
    const src = readFileSync('components/modules/goals-module.tsx', 'utf8');
    expect(src).toContain('const canDelete = isManager(role);');
    expect(src.match(/onDelete=\{canDelete \? remove : undefined\}/g)).toHaveLength(2);
    expect(src).toContain('{onDelete && (');
  });
});
