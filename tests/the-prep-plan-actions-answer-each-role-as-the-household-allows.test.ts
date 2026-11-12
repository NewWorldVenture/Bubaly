// generatePrepPlansAction, called the way the Prep Plans page calls it, by
// every household role, against two households.
//
// THE POLICY, from the sources rather than from the action:
//   - `prep_plans` and `prep_plan_steps` carry 0131's four `is_family_member`
//     policies (supabase/migrations/0131_prep_plans.sql:60-67) and nothing later
//     narrows them or attaches 0464's guest guard. Navigation lists Prep Plans
//     at minLevel 0 with no `manage` flag, and components/modules/planning-module.tsx
//     offers "Generate plans" with no role check. Generation is the idempotent
//     rebuild the model-refresh cron also runs (lib/planning/prep-server.ts).
//     So every member but a guest is pinned as allowed. A guest is reported for
//     an owner decision: the database lets a guest write these rows, while
//     lib/constants/roles.ts describes a guest as viewing and 0464's header
//     says every model has a guest look and not write.
//   - The action takes no id: the family is the session's, and nothing of
//     another family is read, planned or retired.
//
// Mocked: the session and the server client factory. The clock is pinned so the
// trip below is inside the 120-day horizon in every TZ the suite runs under.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { CALLERS, FAMILY_A, FAMILY_B, memberRows, userIdOf, type Caller } from './helpers/role-callers';

const harness = vi.hoisted(() => ({
  caller: 'parent' as string | null,
  db: null as unknown,
}));

vi.mock('@/lib/supabase/auth', async () => {
  const callers = await import('./helpers/role-callers');
  return {
    requireUserContext: async () => (harness.caller
      ? callers.contextFor(harness.caller as Caller)
      : callers.signedOut()),
  };
});
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db, createServiceClient: () => harness.db }));

const { generatePrepPlansAction } = await import('@/app/(app)/dashboard/prep-plans/prep-actions');

const NOW = '2026-11-12T15:00:00.000Z';
const TRIP_A = 'a0000000-0000-4000-8000-0000000d0001';
const TRIP_B = 'b0000000-0000-4000-8000-0000000d0001';
const PAST_PLAN_A = 'a0000000-0000-4000-8000-0000000e0001';
const PAST_PLAN_B = 'b0000000-0000-4000-8000-0000000e0001';

/** Every caller pinned as allowed; a guest is the owner's decision and is left out. */
const PLANNERS: Caller[] = CALLERS.filter((c) => c !== 'guest');

let db: InMemorySupabase;
const plans = () => db.table('prep_plans');
const plan = (id: string) => plans().find((row) => row.id === id) as Row | undefined;
const familyB = () => structuredClone({
  plans: plans().filter((row) => row.family_id === FAMILY_B),
  steps: db.table('prep_plan_steps').filter((row) => row.family_id === FAMILY_B),
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase({
    uniques: {
      prep_plans: [['family_id', 'signal_kind', 'signal_id']],
      prep_plan_steps: [['family_id', 'plan_id', 'label']],
    },
    defaults: { prep_plans: { status: 'active' }, prep_plan_steps: { is_done: false } },
  });
  harness.db = db;
  harness.caller = 'parent';
  db.seed('family_members', [...memberRows(FAMILY_A), ...memberRows(FAMILY_B)]);
  db.seed('vacations', [
    { id: TRIP_A, family_id: FAMILY_A, title: 'Lisbon', start_date: '2026-12-01' },
    { id: TRIP_B, family_id: FAMILY_B, title: 'Their trip', start_date: '2026-12-02' },
  ]);
  // A plan whose day has passed, in each family: a run retires its own family's only.
  db.seed('prep_plans', [
    { id: PAST_PLAN_A, family_id: FAMILY_A, signal_kind: 'trip', signal_id: 'a0000000-0000-4000-8000-0000000d0009', title: 'Old trip', target_date: '2026-10-01', urgency: 'low', status: 'active' },
    { id: PAST_PLAN_B, family_id: FAMILY_B, signal_kind: 'trip', signal_id: 'b0000000-0000-4000-8000-0000000d0009', title: 'Their old trip', target_date: '2026-10-01', urgency: 'low', status: 'active' },
  ]);
});

afterEach(() => { vi.useRealTimers(); });

const as = (caller: Caller | null) => { harness.caller = caller; };

describe('generatePrepPlansAction (ACTION-FB1C60C3CE5A)', () => {
  it.each(PLANNERS)('ACTION-FB1C60C3CE5A a %s plans their own family\'s trip, with its steps, and retires its past plan', async (caller) => {
    as(caller);
    expect(await generatePrepPlansAction()).toEqual({ ok: true, plans: 1 });

    const tripPlans = plans().filter((row) => row.signal_id === TRIP_A);
    expect(tripPlans).toEqual([expect.objectContaining({
      family_id: FAMILY_A, signal_kind: 'trip', target_date: '2026-12-01', created_by: userIdOf(caller),
    })]);
    const steps = db.table('prep_plan_steps').filter((row) => row.plan_id === tripPlans[0].id);
    expect(steps.length).toBeGreaterThan(0);
    expect(steps.every((row) => row.family_id === FAMILY_A)).toBe(true);
    expect(plan(PAST_PLAN_A)?.status).toBe('done');
  });

  it("ACTION-FB1C60C3CE5A plans nothing for another family's trip and leaves their plans as they were", async () => {
    const before = familyB();
    await generatePrepPlansAction();

    expect(plans().filter((row) => row.signal_id === TRIP_B)).toEqual([]);
    expect(familyB()).toEqual(before);
    expect(plan(PAST_PLAN_B)?.status).toBe('active');
  });

  it('ACTION-FB1C60C3CE5A a signed-out caller is sent to sign in and nothing is written', async () => {
    as(null);
    const before = structuredClone(plans());
    await expect(generatePrepPlansAction()).rejects.toThrow('NEXT_REDIRECT');
    expect(plans()).toEqual(before);
    expect(db.table('prep_plan_steps')).toEqual([]);
  });
});
