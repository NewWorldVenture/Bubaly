// Call-level role tests for app/(app)/dashboard/goals/actions.ts.
//
// THE POLICY, from the sources:
//   - goals' live policies are 0478: insert and update are any member's but a
//     guest's or a caregiver's; delete is `can_manage_family` (parent, adult).
//   - lib/services/goals/index.ts says the same in assertGoalWriter (guest and
//     caregiver refused) and assertGoalRemover (manager only), and the module
//     offers Delete only to a manager (components/modules/goals-module.tsx:34).
//   - Every update and delete is family-scoped by the service.
//
// The plan gate is NOT pinned: /dashboard/goals is a Family Basic feature
// (lib/constants/feature-catalog.ts:128) checked only by the page's
// requireFeature, and none of these actions checks it. That is reported in the
// PR as a defect rather than committed as a failing case.
//
// Only the session, the client factory, the translator and next/cache are
// stubbed; the actions, the goals service and the activity feed are the real
// code.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { CHILD_LOGIN_EMAIL_DOMAIN } from '@/lib/onboarding/child-login';

const mocks = vi.hoisted(() => ({
  requireUserContext: vi.fn(),
  revalidatePath: vi.fn(),
  client: null as unknown,
}));

vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => mocks.client }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));

const { deleteGoalAction, saveGoalAction, setGoalProgressAction } = await import('@/app/(app)/dashboard/goals/actions');

const FAMILY_A = 'a0000000-0000-4000-8000-00000000000a';
const FAMILY_B = 'b0000000-0000-4000-8000-00000000000b';
const ROLES = ['parent', 'adult', 'teen', 'child', 'caregiver', 'guest'] as const;
type Role = (typeof ROLES)[number];
const WRITERS = ['parent', 'adult', 'teen', 'child'] as const;
const NOT_WRITERS = ['caregiver', 'guest'] as const;
const MANAGERS = ['parent', 'adult'] as const;
const NOT_MANAGERS = ['teen', 'child', 'caregiver', 'guest'] as const;

const USER: Record<Role | 'kid', string> = {
  parent: 'a0000000-0000-4000-8000-0000000000a1',
  adult: 'a0000000-0000-4000-8000-0000000000a2',
  teen: 'a0000000-0000-4000-8000-0000000000a3',
  child: 'a0000000-0000-4000-8000-0000000000a4',
  caregiver: 'a0000000-0000-4000-8000-0000000000a5',
  guest: 'a0000000-0000-4000-8000-0000000000a6',
  kid: 'a0000000-0000-4000-8000-0000000000a7',
};

const GOAL_A = 'a0000000-0000-4000-8000-0000000000e1';
const GOAL_B = 'b0000000-0000-4000-8000-0000000000e2';
const SEEDED_A = { id: GOAL_A, family_id: FAMILY_A, title: 'Hike every weekend', description: null, target_date: '2026-12-31', progress: 20, is_complete: false, created_by: USER.parent };
const SEEDED_B = { id: GOAL_B, family_id: FAMILY_B, title: 'Read 20 books', description: null, target_date: null, progress: 50, is_complete: false, created_by: 'b0000000-0000-4000-8000-0000000000b1' };

let db: InMemorySupabase;

function signedInAs(role: Role, opts: { user?: string; email?: string } = {}) {
  const userId = opts.user ?? USER[role];
  mocks.requireUserContext.mockResolvedValue({
    user: { id: userId, email: opts.email ?? `${role}@example.com` },
    memberships: [],
    active: { familyId: FAMILY_A, family: { id: FAMILY_A, timezone: 'UTC' }, role, member: { id: `member-${userId}` } },
  });
}
const signedInAsKidLogin = () => signedInAs('child', { user: USER.kid, email: `mia@${CHILD_LOGIN_EMAIL_DOMAIN}` });

const goals = (filter: (r: Row) => boolean = () => true) => db.table('goals').filter(filter);
const goalA = () => goals((r) => r.id === GOAL_A)[0];
const snapshot = () => structuredClone(db.table('goals'));
const familyB = () => structuredClone(goals((r) => r.family_id === FAMILY_B));

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase();
  mocks.client = db;
  db.seed('goals', [structuredClone(SEEDED_A), structuredClone(SEEDED_B)]);
});

describe('saveGoalAction (create)', () => {
  it.each(WRITERS)('ACTION-5E65B4B68F7C %s creates one goal in household A under their own name', async (role) => {
    signedInAs(role);
    const before = familyB();
    const result = await saveGoalAction(null, { title: ' Learn to swim ', description: 'Lessons on Saturdays', targetDate: '2027-06-01' });
    expect(result).toEqual({ ok: true, id: expect.any(String) });
    const created = goals((r) => r.title === 'Learn to swim');
    expect(created).toEqual([expect.objectContaining({
      family_id: FAMILY_A, description: 'Lessons on Saturdays', target_date: '2027-06-01', progress: 0, is_complete: false, created_by: USER[role],
    })]);
    expect(result.ok && result.id).toBe(created[0]?.id);
    expect(familyB()).toEqual(before);
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/dashboard/goals');
  });

  it('ACTION-5E65B4B68F7C a kid login creates a goal under its own name', async () => {
    signedInAsKidLogin();
    await expect(saveGoalAction(null, { title: 'Tidy my room daily' })).resolves.toEqual({ ok: true, id: expect.any(String) });
    expect(goals((r) => r.title === 'Tidy my room daily')).toEqual([expect.objectContaining({ family_id: FAMILY_A, created_by: USER.kid })]);
  });

  it.each(NOT_WRITERS)('ACTION-5E65B4B68F7C %s is refused and no goal is written', async (role) => {
    signedInAs(role);
    const before = snapshot();
    await expect(saveGoalAction(null, { title: 'Learn to swim' }))
      .resolves.toEqual({ ok: false, error: 'Only a member of the household can change its goals.' });
    expect(snapshot()).toEqual(before);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('ACTION-5E65B4B68F7C a create the database refuses is reported, not answered ok', async () => {
    signedInAs('child');
    mocks.client = withFaults(db, (table, calls) =>
      table === 'goals' && calls.some((c) => c.method === 'insert') ? { code: '42501', message: 'new row violates row-level security policy for table "goals"' } : null);
    const result = await saveGoalAction(null, { title: 'Learn to swim' });
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/permission/i) });
    expect(goals()).toHaveLength(2);
  });
});

describe('saveGoalAction (edit)', () => {
  it.each(WRITERS)('ACTION-5E65B4B68F7C %s edits household A\'s goal, and only the fields sent change', async (role) => {
    signedInAs(role);
    const before = familyB();
    await expect(saveGoalAction(GOAL_A, { title: 'Hike twice a month', targetDate: '' }))
      .resolves.toEqual({ ok: true, id: GOAL_A });
    expect(goalA()).toEqual({ ...SEEDED_A, title: 'Hike twice a month', target_date: null, created_at: expect.any(String), updated_at: expect.any(String) });
    expect(familyB()).toEqual(before);
  });

  it.each(NOT_WRITERS)('ACTION-5E65B4B68F7C %s cannot edit a goal and nothing changes', async (role) => {
    signedInAs(role);
    const before = snapshot();
    await expect(saveGoalAction(GOAL_A, { title: 'Hike twice a month' }))
      .resolves.toEqual({ ok: false, error: 'Only a member of the household can change its goals.' });
    expect(snapshot()).toEqual(before);
  });

  it.each(WRITERS)('ACTION-5E65B4B68F7C %s cannot edit household B\'s goal by its id, and nothing changes', async (role) => {
    signedInAs(role);
    const before = snapshot();
    await expect(saveGoalAction(GOAL_B, { title: 'Hijacked' })).resolves.toEqual({ ok: false, error: 'That goal could not be found.' });
    expect(snapshot()).toEqual(before);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});

describe('setGoalProgressAction', () => {
  it.each(WRITERS)('ACTION-B26796481B72 %s sets progress and completion is derived', async (role) => {
    signedInAs(role);
    const before = familyB();
    await expect(setGoalProgressAction(GOAL_A, 60)).resolves.toEqual({ ok: true, id: GOAL_A });
    expect(goalA()).toMatchObject({ progress: 60, is_complete: false, title: SEEDED_A.title });
    await expect(setGoalProgressAction(GOAL_A, 100)).resolves.toEqual({ ok: true, id: GOAL_A });
    expect(goalA()).toMatchObject({ progress: 100, is_complete: true });
    expect(familyB()).toEqual(before);
  });

  it('ACTION-B26796481B72 a kid login moves a goal\'s progress', async () => {
    signedInAsKidLogin();
    await expect(setGoalProgressAction(GOAL_A, 45)).resolves.toEqual({ ok: true, id: GOAL_A });
    expect(goalA()).toMatchObject({ progress: 45 });
  });

  it.each(NOT_WRITERS)('ACTION-B26796481B72 %s cannot move progress and nothing changes', async (role) => {
    signedInAs(role);
    const before = snapshot();
    await expect(setGoalProgressAction(GOAL_A, 100))
      .resolves.toEqual({ ok: false, error: 'Only a member of the household can change its goals.' });
    expect(snapshot()).toEqual(before);
  });

  it.each(WRITERS)('ACTION-B26796481B72 %s cannot move household B\'s goal by its id, and nothing changes', async (role) => {
    signedInAs(role);
    const before = snapshot();
    await expect(setGoalProgressAction(GOAL_B, 100)).resolves.toEqual({ ok: false, error: 'That goal could not be found.' });
    expect(snapshot()).toEqual(before);
  });

  it('ACTION-B26796481B72 a value outside 0..100 is refused and nothing changes', async () => {
    signedInAs('parent');
    const before = snapshot();
    await expect(setGoalProgressAction(GOAL_A, 250)).resolves.toEqual({ ok: false, error: 'Goal progress is a percentage between 0 and 100.' });
    expect(snapshot()).toEqual(before);
  });
});

describe('deleteGoalAction', () => {
  it.each(MANAGERS)('ACTION-B3B4E4153D21 %s removes household A\'s goal and nothing else', async (role) => {
    signedInAs(role);
    const before = familyB();
    await expect(deleteGoalAction(GOAL_A)).resolves.toEqual({ ok: true, id: GOAL_A });
    expect(goals((r) => r.family_id === FAMILY_A)).toEqual([]);
    expect(familyB()).toEqual(before);
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/dashboard/goals');
  });

  it.each(NOT_MANAGERS)('ACTION-B3B4E4153D21 %s cannot remove a family goal and it stays', async (role) => {
    signedInAs(role);
    const before = snapshot();
    await expect(deleteGoalAction(GOAL_A)).resolves.toEqual({ ok: false, error: 'Only a parent or another adult can remove a family goal.' });
    expect(snapshot()).toEqual(before);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('ACTION-B3B4E4153D21 a kid login cannot remove a family goal', async () => {
    signedInAsKidLogin();
    const before = snapshot();
    await expect(deleteGoalAction(GOAL_A)).resolves.toEqual({ ok: false, error: 'Only a parent or another adult can remove a family goal.' });
    expect(snapshot()).toEqual(before);
  });

  it.each(MANAGERS)('ACTION-B3B4E4153D21 %s cannot remove household B\'s goal by its id, and nothing changes', async (role) => {
    signedInAs(role);
    const before = snapshot();
    await expect(deleteGoalAction(GOAL_B)).resolves.toEqual({ ok: false, error: 'That goal could not be found.' });
    expect(snapshot()).toEqual(before);
  });
});

describe('a signed-out caller', () => {
  it('ACTION-5E65B4B68F7C ACTION-B26796481B72 ACTION-B3B4E4153D21 is sent to login by every goals action, and nothing changes', async () => {
    mocks.requireUserContext.mockRejectedValue(new Error('NEXT_REDIRECT:/login'));
    const before = snapshot();
    await expect(saveGoalAction(null, { title: 'Learn to swim' })).rejects.toThrow('NEXT_REDIRECT');
    await expect(saveGoalAction(GOAL_A, { title: 'x' })).rejects.toThrow('NEXT_REDIRECT');
    await expect(setGoalProgressAction(GOAL_A, 90)).rejects.toThrow('NEXT_REDIRECT');
    await expect(deleteGoalAction(GOAL_A)).rejects.toThrow('NEXT_REDIRECT');
    expect(snapshot()).toEqual(before);
  });
});
