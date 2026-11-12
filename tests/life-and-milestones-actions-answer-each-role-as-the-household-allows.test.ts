// Call-level role tests for app/(app)/dashboard/life-event-actions.ts
// (Register B: ACTION-545BEF9BFE45 launchLifeEventAction,
// ACTION-F4D4116828A1 setLifeEventStatusAction).
//
// THE POLICY, from the sources rather than from the action:
//   - life_event_plans / life_event_plan_items: 0145 gives every member all four
//     commands (is_family_member); no later migration narrows them.
//   - 0464 (ROLE-M03): a guest views the household and does not write it; the
//     action's own comments apply that to launching and to a plan's status.
//   - components/modules/life-events-module.tsx:125 offers Start and the status
//     controls to `role !== 'guest'`, so parent, adult, teen, child and
//     caregiver all plan.
// So: every role but a guest writes, a guest is refused and writes nothing, and
// an id from another family is "not found" and changes nothing in either family.
//
// Driven: the REAL actions and the REAL launcher (lib/life-events/launch.ts and
// the services it calls) against the in-memory PostgREST fake. Only the session,
// the client factory and the translator (key in, key out) are stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const mocks = vi.hoisted(() => ({ db: null as unknown, role: 'parent', familyId: 'family-a' }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => mocks.db, createServiceClient: () => mocks.db }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: `user-${mocks.role}`, email: `${mocks.role}@example.com` },
    memberships: [],
    active: {
      familyId: mocks.familyId, role: mocks.role, member: { id: `member-${mocks.role}` },
      family: { id: mocks.familyId, timezone: 'UTC' },
    },
  }),
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { launchLifeEventAction, setLifeEventStatusAction } = await import('@/app/(app)/dashboard/life-event-actions');

const A = 'family-a';
const B = 'family-b';
const PLAN_A = '00000000-0000-4000-8000-0000000000a1';
const PLAN_B = '00000000-0000-4000-8000-0000000000b1';
const WRITERS = ['parent', 'adult', 'teen', 'child', 'caregiver'] as const;
const WRITTEN = ['life_event_plans', 'life_event_plan_items', 'todo_lists', 'todo_items', 'family_reminders', 'moves', 'move_tasks'] as const;
const GUEST_REFUSED = { ok: false, error: 'householdRoles.guestViewsOnly' };

let db: InMemorySupabase;
const as = (role: string) => { mocks.role = role; };
/** Every table a launch or a status change could touch, frozen for comparison. */
const everything = () => structuredClone(Object.fromEntries(WRITTEN.map((t) => [t, db.table(t)])));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-23T12:00:00.000Z'));
  db = createInMemorySupabase({ defaults: { moves: { status: 'planning' } } });
  mocks.db = db;
  mocks.familyId = A;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db.seed('family_members', [
    ...['parent', 'adult', 'teen', 'child', 'caregiver', 'guest'].map((role) => ({
      id: `member-${role}`, family_id: A, user_id: `user-${role}`, role, display_name: role, is_active: true,
    })),
    { id: 'member-b-parent', family_id: B, user_id: 'user-b-parent', role: 'parent', display_name: 'B parent', is_active: true },
  ]);
  db.seed('life_event_plans', [
    { id: PLAN_A, family_id: A, template_key: 'new_pet', title: 'New Pet', event_date: '2026-11-20', status: 'active' },
    { id: PLAN_B, family_id: B, template_key: 'new_pet', title: 'New Pet', event_date: '2026-11-20', status: 'active' },
  ]);
  as('parent');
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('launchLifeEventAction', () => {
  it.each(WRITERS)('ACTION-545BEF9BFE45 a %s starts a playbook: one plan, its checklist and to-dos, all in their own family', async (role) => {
    as(role);
    const result = await launchLifeEventAction('emergency_prep', '2026-12-01');
    expect(result).toMatchObject({ ok: true, created: { handoff: null } });

    const plans = db.table('life_event_plans').filter((p) => p.template_key === 'emergency_prep');
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ id: result.planId, family_id: A, event_date: '2026-12-01', created_by: `user-${role}` });
    const items = db.table('life_event_plan_items');
    expect(items.length).toBe(result.created?.items);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.family_id === A && i.plan_id === result.planId)).toBe(true);
    expect(db.table('todo_items').length).toBe(result.created?.todos);
    expect(db.table('todo_items').length).toBeGreaterThan(0);
    expect(db.table('todo_items').every((t) => t.family_id === A)).toBe(true);
    // Family B's plan is untouched.
    expect(db.table('life_event_plans').find((p) => p.id === PLAN_B)).toMatchObject({ family_id: B, status: 'active' });
  });

  it.each(['moving', 'emergency_prep'])('ACTION-545BEF9BFE45 a guest is refused %s and nothing is written anywhere', async (template) => {
    as('guest');
    const before = everything();
    expect(await launchLifeEventAction(template, '2026-12-01')).toEqual(GUEST_REFUSED);
    expect(everything()).toEqual(before);
  });

  it('ACTION-545BEF9BFE45 an unknown template is refused before the session is read, and writes nothing', async () => {
    const before = everything();
    expect(await launchLifeEventAction('not_a_template', '2026-12-01')).toEqual({ ok: false, error: 'lifeEventActions.unknownLifeEvent' });
    expect(everything()).toEqual(before);
  });

  it("ACTION-545BEF9BFE45 a launch takes no family argument: it lands in the caller's family and family B gains nothing", async () => {
    await launchLifeEventAction('emergency_prep', '2026-12-01');
    for (const table of WRITTEN) {
      expect(db.table(table).filter((r) => r.family_id === B && r.id !== PLAN_B), table).toEqual([]);
    }
  });
});

describe('setLifeEventStatusAction', () => {
  it.each(WRITERS)('ACTION-F4D4116828A1 a %s completes their family plan and only that row changes', async (role) => {
    as(role);
    expect(await setLifeEventStatusAction(PLAN_A, 'completed')).toEqual({ ok: true });
    expect(db.table('life_event_plans').find((p) => p.id === PLAN_A)?.status).toBe('completed');
    expect(db.table('life_event_plans').find((p) => p.id === PLAN_B)?.status).toBe('active');
  });

  it('ACTION-F4D4116828A1 a guest is refused and the plan stays active', async () => {
    as('guest');
    const before = everything();
    expect(await setLifeEventStatusAction(PLAN_A, 'archived')).toEqual(GUEST_REFUSED);
    expect(everything()).toEqual(before);
  });

  it.each(['parent', 'teen'])("ACTION-F4D4116828A1 a %s naming family B's plan is told it is not found, and neither family changes", async (role) => {
    as(role);
    const before = everything();
    expect(await setLifeEventStatusAction(PLAN_B, 'archived')).toEqual({ ok: false, error: 'lifeEventActions.invalidPlan' });
    expect(everything()).toEqual(before);
  });

  it('ACTION-F4D4116828A1 an empty plan id is refused and writes nothing', async () => {
    const before = everything();
    expect(await setLifeEventStatusAction('', 'completed')).toEqual({ ok: false, error: 'lifeEventActions.invalidPlan' });
    expect(everything()).toEqual(before);
  });
});
