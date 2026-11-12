// Call-level role tests for app/(app)/dashboard/meals/actions.ts
// (Register B: ACTION-73DB0E2176B9 createMealAction, ACTION-1A67F7331B29
// planMealAction, ACTION-91AEADE5CC7B removeMealPlanAction).
//
// THE POLICY, from the sources rather than from the action:
//   - meals and meal_plans: 0004 gives every member all four commands
//     (is_family_member). 0464 (ROLE-M03) adds a guest-write trigger on
//     `meals` (a guest views the household and does not write it); its header
//     records that children, teens and caregivers writing these resources is
//     the owner's "consistent-open by design" call (ROLE-SCOPE-001).
//   - The actions refuse a guest a plan or a clear; the module
//     (components/modules/meals-module.tsx) offers planning to every member.
// So parent, adult, teen, child and caregiver plan, clear and add dishes; a
// guest is refused planning and clearing and writes nothing; an id from another
// family is "not found" and changes nothing in either family.
//
// NOT PINNED HERE: createMealAction for a guest. The action has no guest gate
// and writes the dish; 0464's trigger on `meals` says it must not. That is
// reported as a defect in the PR, not committed as a failing case.
//
// Driven: the REAL actions and the REAL meals service against the in-memory
// PostgREST fake. Only the session, the client factory and the translator
// (key in, key out) are stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const mocks = vi.hoisted(() => ({ db: null as unknown, role: 'parent', revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => mocks.db, createServiceClient: () => mocks.db }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: `user-${mocks.role}`, email: `${mocks.role}@example.com` },
    memberships: [],
    active: {
      familyId: A, role: mocks.role, member: { id: `member-${mocks.role}` },
      family: { id: A, timezone: 'UTC' },
    },
  }),
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));

const { createMealAction, planMealAction, removeMealPlanAction } = await import('@/app/(app)/dashboard/meals/actions');

const A = 'family-a';
const B = 'family-b';
const DAY = '2026-11-16';
const MEAL_A = '00000000-0000-4000-8000-00000000a001';
const MEAL_B = '00000000-0000-4000-8000-00000000b001';
const RECIPE_B = '00000000-0000-4000-8000-00000000b002';
const PLAN_A = '00000000-0000-4000-8000-00000000a003';
const PLAN_B = '00000000-0000-4000-8000-00000000b003';
const WRITERS = ['parent', 'adult', 'teen', 'child', 'caregiver'] as const;
const NOT_ALLOWED = { ok: false, error: 'actionRefusal.notAllowed' };

let db: InMemorySupabase;
const as = (role: string) => { mocks.role = role; };
const state = () => structuredClone({
  meals: db.table('meals'), plans: db.table('meal_plans'), recipes: db.table('family_recipes'),
});
const familyRows = (table: string, family: string) => db.table(table).filter((r) => r.family_id === family);

beforeEach(() => {
  vi.clearAllMocks();
  db = createInMemorySupabase();
  mocks.db = db;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db.seed('meals', [
    { id: MEAL_A, family_id: A, name: 'Tacos', meal_type: 'dinner', ingredients: [], created_at: '2026-01-01T00:00:00Z' },
    { id: MEAL_B, family_id: B, name: 'Lasagne', meal_type: 'dinner', ingredients: [], created_at: '2026-01-01T00:00:00Z' },
  ]);
  db.seed('family_recipes', [
    { id: RECIPE_B, family_id: B, name: 'Secret Stew', ingredients: [], source_url: null, photo_url: null },
  ]);
  db.seed('meal_plans', [
    { id: PLAN_A, family_id: A, meal_id: MEAL_A, plan_date: '2026-11-17', meal_type: 'dinner', created_by: 'user-parent' },
    { id: PLAN_B, family_id: B, meal_id: MEAL_B, plan_date: '2026-11-17', meal_type: 'dinner', created_by: 'user-b' },
  ]);
  as('parent');
});
afterEach(() => vi.restoreAllMocks());

describe('planMealAction', () => {
  it.each(WRITERS)("ACTION-1A67F7331B29 a %s plans a saved dish into their family's slot, and only that row is added", async (role) => {
    as(role);
    const result = await planMealAction({ date: DAY, mealType: 'dinner', mealId: MEAL_A });
    expect(result).toMatchObject({ ok: true, slot: { date: DAY, mealType: 'dinner', mealId: MEAL_A, name: 'Tacos' } });
    const added = familyRows('meal_plans', A).filter((p) => p.plan_date === DAY);
    expect(added).toEqual([expect.objectContaining({ meal_id: MEAL_A, meal_type: 'dinner', created_by: `user-${role}` })]);
    expect(familyRows('meal_plans', B)).toEqual([expect.objectContaining({ id: PLAN_B })]);
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/dashboard/meals');
  });

  it('ACTION-1A67F7331B29 a guest is refused and no slot or dish is written', async () => {
    as('guest');
    const before = state();
    expect(await planMealAction({ date: DAY, mealType: 'dinner', mealName: 'Pancakes' })).toEqual(NOT_ALLOWED);
    expect(await planMealAction({ date: DAY, mealType: 'dinner', mealId: MEAL_A })).toEqual(NOT_ALLOWED);
    expect(state()).toEqual(before);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it.each(['parent', 'child'])("ACTION-1A67F7331B29 a %s naming family B's dish is told it is not found, and neither family changes", async (role) => {
    as(role);
    const before = state();
    expect(await planMealAction({ date: DAY, mealType: 'dinner', mealId: MEAL_B })).toEqual({ ok: false, error: 'That meal could not be found.' });
    expect(state()).toEqual(before);
  });

  it("ACTION-1A67F7331B29 a parent naming family B's recipe is told it is not found, and neither family changes", async () => {
    const before = state();
    expect(await planMealAction({ date: DAY, mealType: 'dinner', recipeId: RECIPE_B })).toEqual({ ok: false, error: 'That recipe could not be found.' });
    expect(state()).toEqual(before);
  });
});

describe('removeMealPlanAction', () => {
  it.each(WRITERS)("ACTION-91AEADE5CC7B a %s clears their family's slot; the dish stays and family B's slot stays", async (role) => {
    as(role);
    expect(await removeMealPlanAction(PLAN_A)).toEqual({ ok: true, id: PLAN_A });
    expect(db.table('meal_plans').map((p) => p.id)).toEqual([PLAN_B]);
    expect(db.table('meals').map((m) => m.id)).toEqual([MEAL_A, MEAL_B]);
  });

  it('ACTION-91AEADE5CC7B a guest is refused and the slot stays', async () => {
    as('guest');
    const before = state();
    expect(await removeMealPlanAction(PLAN_A)).toEqual(NOT_ALLOWED);
    expect(state()).toEqual(before);
  });

  it.each(['parent', 'teen'])("ACTION-91AEADE5CC7B a %s naming family B's slot is told it is not found, and neither family changes", async (role) => {
    as(role);
    const before = state();
    expect(await removeMealPlanAction(PLAN_B)).toEqual({ ok: false, error: 'That planned meal could not be found.' });
    expect(state()).toEqual(before);
  });
});

describe('createMealAction', () => {
  it.each(WRITERS)("ACTION-73DB0E2176B9 a %s adds a dish to their own family's library, and family B's library is untouched", async (role) => {
    as(role);
    const result = await createMealAction({ name: 'Shakshuka', mealType: 'breakfast' });
    expect(result).toMatchObject({ ok: true, meal: { name: 'Shakshuka', family_id: A, meal_type: 'breakfast' } });
    expect(familyRows('meals', A).filter((m) => m.name === 'Shakshuka'))
      .toEqual([expect.objectContaining({ created_by: `user-${role}` })]);
    expect(familyRows('meals', B)).toEqual([expect.objectContaining({ id: MEAL_B })]);
  });

  it("ACTION-73DB0E2176B9 a dish of the same name as family B's is created in A, not matched to B's row", async () => {
    const result = await createMealAction({ name: 'Lasagne', mealType: 'dinner' });
    expect(result).toMatchObject({ ok: true, meal: { family_id: A } });
    expect(result.ok && result.meal.id).not.toBe(MEAL_B);
    expect(db.table('meals').find((m) => m.id === MEAL_B)).toMatchObject({ family_id: B, name: 'Lasagne' });
  });
});
