// Call-level role tests for the Smart Kitchen server actions
// (app/(app)/dashboard/kitchen/actions.ts), Register B rows
// ACTION-1153C80AAF7F (add leftover), ACTION-1529E29192D5 (leftover status),
// ACTION-76FAFB715AEE (delete leftover) and ACTION-A7A7EDE23299 (food score).
//
// THE POLICY, from the sources and not from the action:
//   - 0102_food_os.sql:38-41: leftover_inventory is FOR ALL to any member
//     (is_family_member), and no later migration narrows the roles.
//   - 0481_the_rls_sweep_narrows_the_household_tables_to_their_roles.sql:620-632:
//     family_food_scores insert/update are any member's, stamped with the
//     caller's own id (created_by / updated_by = auth.uid()).
//   - 0481:607-637 and 707-717 put 0464's household_write_is_not_a_guests()
//     trigger on BOTH tables: a guest sees the kitchen and does not change it.
//   - components/modules/kitchen-dashboard.tsx offers the leftover and score
//     controls with no role check.
// So a parent, adult, teen, child (a kid login is a child member: the same
// context) or caregiver logs, updates and removes leftovers and files the
// day's score, always in their OWN family; an id from another family is
// refused and nothing in either family changes.
//
// NOT PINNED HERE, because the action does what the sources say it must not
// (reported as defects, not committed as failing tests):
//   - a GUEST: none of the four actions refuses one, so the write goes to the
//     database, where 0481's trigger answers 42501;
//   - the PLAN: Smart Kitchen is a 'basic' feature
//     (lib/constants/feature-catalog.ts:29, navigation minLevel 1) and only the
//     page asks (kitchen/page.tsx requireFeature); the actions never read the
//     plan.
//
// The real exported actions run against tests/helpers/in-memory-supabase.ts;
// only the signed-in context, the translator (key in, key out) and next/cache
// are stubbed. The fake has no RLS, so a refusal here is the action's own.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const mocks = vi.hoisted(() => ({
  requireUserContext: vi.fn(),
  db: null as unknown,
  revalidatePath: vi.fn(),
}));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => mocks.db }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));

const { addLeftoverAction, updateLeftoverStatusAction, deleteLeftoverAction, snapshotFoodScoreAction } =
  await import('@/app/(app)/dashboard/kitchen/actions');

const FAMILY_A = '00000000-0000-4000-8000-00000000000a';
const FAMILY_B = '00000000-0000-4000-8000-00000000000b';
const LEFTOVER_A = '00000000-0000-4000-8000-0000000004a1';
const LEFTOVER_B = '00000000-0000-4000-8000-0000000004b1';
// Midday UTC: the same calendar day in every zone the suite runs under.
const NOW = new Date('2026-11-12T12:00:00Z');
const TODAY = '2026-11-12';

const MEMBERS = ['parent', 'adult', 'teen', 'child', 'caregiver'] as const;

let db: InMemorySupabase;

const userOf = (role: string) => `user-${role}`;

function signInAs(role: string) {
  mocks.requireUserContext.mockResolvedValue({
    user: { id: userOf(role), email: `${role}@example.com` },
    memberships: [],
    active: { familyId: FAMILY_A, role, family: { id: FAMILY_A, timezone: 'UTC' }, member: { id: `member-${role}` } },
  });
}

const everything = () => structuredClone({
  leftovers: db.table('leftover_inventory'),
  scores: db.table('family_food_scores'),
});
const leftover = (id: string) => db.table('leftover_inventory').find((r) => r.id === id);
const scoreInput = { overall: 81.6, grade: 'B', subScores: [], coaching: ['Add a vegetable to Tuesday'] };

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  db = createInMemorySupabase({ uniques: { family_food_scores: [['family_id', 'snapshot_date']] } });
  mocks.db = db;
  db.seed('leftover_inventory', [
    { id: LEFTOVER_A, family_id: FAMILY_A, name: 'Chili', status: 'fresh', location: 'fridge', created_by: 'user-parent', updated_by: 'user-parent' },
    { id: LEFTOVER_B, family_id: FAMILY_B, name: 'Soup', status: 'fresh', location: 'fridge', created_by: 'user-b', updated_by: 'user-b' },
  ]);
  db.seed('family_food_scores', [
    { id: 'score-b', family_id: FAMILY_B, snapshot_date: TODAY, overall: 40, grade: 'D', created_by: 'user-b', updated_by: 'user-b' },
  ]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('addLeftoverAction', () => {
  it.each(MEMBERS)('ACTION-1153C80AAF7F the %s logs a leftover in their own family, stamped as theirs', async (role) => {
    signInAs(role);
    const result = await addLeftoverAction({ name: '  Lasagne ', quantity: '2 slices', location: 'freezer' });
    expect(result.ok).toBe(true);
    const added = db.table('leftover_inventory').filter((r) => r.name === 'Lasagne');
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      family_id: FAMILY_A, created_by: userOf(role), updated_by: userOf(role), quantity: '2 slices', location: 'freezer',
    });
    expect(result).toEqual({ ok: true, data: { id: added[0].id } });
    expect(db.table('leftover_inventory').filter((r) => r.family_id === FAMILY_B)).toHaveLength(1);
  });

  it('ACTION-1153C80AAF7F a nameless leftover is refused and nothing is written', async () => {
    signInAs('parent');
    const before = everything();
    expect(await addLeftoverAction({ name: '   ' })).toEqual({ ok: false, error: 'actions.giveTheLeftoverAName' });
    expect(everything()).toEqual(before);
  });

  it('ACTION-1153C80AAF7F a signed-out caller is stopped at the session and writes nothing', async () => {
    mocks.requireUserContext.mockRejectedValue(new Error('NEXT_REDIRECT;/login'));
    const before = everything();
    await expect(addLeftoverAction({ name: 'Lasagne' })).rejects.toThrow('NEXT_REDIRECT');
    expect(everything()).toEqual(before);
  });
});

describe('updateLeftoverStatusAction', () => {
  it.each(MEMBERS)("ACTION-1529E29192D5 the %s marks their family's leftover eaten, and only that row", async (role) => {
    signInAs(role);
    expect(await updateLeftoverStatusAction({ id: LEFTOVER_A, status: 'eaten' })).toEqual({ ok: true });
    expect(leftover(LEFTOVER_A)).toMatchObject({ status: 'eaten', updated_by: userOf(role) });
    expect(leftover(LEFTOVER_B)).toMatchObject({ status: 'fresh', updated_by: 'user-b' });
  });

  it("ACTION-1529E29192D5 a parent naming another family's leftover gets the could-not-update answer and neither family's row changes", async () => {
    signInAs('parent');
    const before = everything();
    expect(await updateLeftoverStatusAction({ id: LEFTOVER_B, status: 'tossed' }))
      .toEqual({ ok: false, error: 'actions.couldNotUpdateThatLeftover' });
    expect(everything()).toEqual(before);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('ACTION-1529E29192D5 a status the page never offers is refused and nothing is written', async () => {
    signInAs('parent');
    const before = everything();
    expect(await updateLeftoverStatusAction({ id: LEFTOVER_A, status: 'stolen' })).toEqual({ ok: false, error: 'actions.invalidStatus' });
    expect(everything()).toEqual(before);
  });

  it('ACTION-1529E29192D5 a signed-out caller is stopped at the session and writes nothing', async () => {
    mocks.requireUserContext.mockRejectedValue(new Error('NEXT_REDIRECT;/login'));
    const before = everything();
    await expect(updateLeftoverStatusAction({ id: LEFTOVER_A, status: 'eaten' })).rejects.toThrow('NEXT_REDIRECT');
    expect(everything()).toEqual(before);
  });
});

describe('deleteLeftoverAction', () => {
  it.each(MEMBERS)("ACTION-76FAFB715AEE the %s removes their family's leftover, and only that row", async (role) => {
    signInAs(role);
    expect(await deleteLeftoverAction({ id: LEFTOVER_A })).toEqual({ ok: true });
    expect(leftover(LEFTOVER_A)).toBeUndefined();
    expect(leftover(LEFTOVER_B)).toMatchObject({ name: 'Soup', status: 'fresh' });
  });

  it("ACTION-76FAFB715AEE a parent naming another family's leftover gets the could-not-delete answer and neither family's row goes", async () => {
    signInAs('parent');
    const before = everything();
    expect(await deleteLeftoverAction({ id: LEFTOVER_B })).toEqual({ ok: false, error: 'actions.couldNotDeleteThatLeftover' });
    expect(everything()).toEqual(before);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('ACTION-76FAFB715AEE a signed-out caller is stopped at the session and deletes nothing', async () => {
    mocks.requireUserContext.mockRejectedValue(new Error('NEXT_REDIRECT;/login'));
    const before = everything();
    await expect(deleteLeftoverAction({ id: LEFTOVER_A })).rejects.toThrow('NEXT_REDIRECT');
    expect(everything()).toEqual(before);
  });
});

describe('snapshotFoodScoreAction', () => {
  it.each(MEMBERS)("ACTION-A7A7EDE23299 the %s files today's score for their own family, stamped as theirs", async (role) => {
    signInAs(role);
    const theirs = structuredClone(db.table('family_food_scores').filter((r) => r.family_id === FAMILY_B));
    expect(await snapshotFoodScoreAction(scoreInput)).toEqual({ ok: true });
    const mine = db.table('family_food_scores').filter((r) => r.family_id === FAMILY_A);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      snapshot_date: TODAY, overall: 82, grade: 'B', created_by: userOf(role), updated_by: userOf(role),
    });
    // Another family's score for the same day is a different row and is untouched.
    expect(db.table('family_food_scores').filter((r) => r.family_id === FAMILY_B)).toEqual(theirs);
    expect(theirs).toHaveLength(1);
  });

  it("ACTION-A7A7EDE23299 a second save the same day restates the family's one row rather than adding another", async () => {
    signInAs('parent');
    expect(await snapshotFoodScoreAction(scoreInput)).toEqual({ ok: true });
    signInAs('teen');
    expect(await snapshotFoodScoreAction({ ...scoreInput, overall: 140, grade: 'A' })).toEqual({ ok: true });
    const mine = db.table('family_food_scores').filter((r) => r.family_id === FAMILY_A);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ overall: 100, grade: 'A', updated_by: 'user-teen' });
  });

  it('ACTION-A7A7EDE23299 a signed-out caller is stopped at the session and writes nothing', async () => {
    mocks.requireUserContext.mockRejectedValue(new Error('NEXT_REDIRECT;/login'));
    const before = everything();
    await expect(snapshotFoodScoreAction(scoreInput)).rejects.toThrow('NEXT_REDIRECT');
    expect(everything()).toEqual(before);
  });
});
