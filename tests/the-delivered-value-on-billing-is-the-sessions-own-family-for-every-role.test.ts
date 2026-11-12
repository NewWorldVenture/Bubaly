// Call-level role tests for the delivered-value read-out on Billing and Home:
// app/(app)/dashboard/billing/value-actions.ts — Register B ACTION-F28061A6CFAD
// (loadFamilyDeliveredValueAction). Its sibling, the value comparison, is in
// tests/the-value-comparison-on-billing-is-the-sessions-own-family-for-every-role.test.ts.
//
// THE POLICY. Both are reads, and both are shown to every role: Home computes
// the same two values for any signed-in member (app/(app)/home/page.tsx:494-497
// and :733), and the upgrade modal renders FamilyDeliveredValue to whoever
// opens it (components/app/upgrade-modal.tsx:121). What they read is open to
// every member of the family by the live policies — completed plan runs
// (family_automation_runs_select, 0251_ai_trust_hardening.sql, `is_family_member`)
// and the plan row (subs_select, 0118_rls_drift_repair.sql:129). A guest is
// withheld /dashboard/billing (lib/auth/guest-scope.ts:28), but these numbers
// reach a guest on Home anyway, and the held 0509 leaves `subscriptions` open
// to a guest on purpose (supabase/reserved/0509_*.sql:40). So every role reads
// the same answer.
//
// The boundary is the household: "the session chooses the household; callers
// cannot request another family's value" (value-actions.ts:10). Neither action
// takes a family id, so a caller who passes household B's id anyway still
// reads A, and B's runs and plan never enter A's numbers.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const mocks = vi.hoisted(() => ({ db: null as unknown, requireUserContext: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => mocks.db }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));

const { loadFamilyDeliveredValueAction } = await import('@/app/(app)/dashboard/billing/value-actions');
const { computeTimeSaved } = await import('@/lib/metric/time-saved');

const FAMILY_A = '00000000-0000-4000-8000-00000000000a';
const FAMILY_B = '00000000-0000-4000-8000-00000000000b';
const ROLES = ['parent', 'adult', 'teen', 'child', 'caregiver', 'guest'] as const;

let db: InMemorySupabase;

function signInAs(role: string) {
  mocks.requireUserContext.mockResolvedValue({
    user: { id: `user-a-${role}`, email: `${role}@example.com` },
    active: { familyId: FAMILY_A, role, member: { id: `member-a-${role}` }, family: { id: FAMILY_A, timezone: 'UTC' } },
  });
}

/** A completed plan run, finished `hoursAgo` before now (always inside the last seven days). */
const run = (family: string, n: number, hoursAgo: number) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  family_id: family, run_type: 'concierge', plan_id: `plan-${n}`, state: 'completed', status: 'executed',
  completed_at: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
});

beforeEach(() => {
  vi.resetAllMocks();
  db = createInMemorySupabase();
  mocks.db = db;
  // Household A: two completed plans this week, on an active Plus plan.
  // Household B: five completed plans, on an active Basic plan.
  db.seed('family_automation_runs', [
    run(FAMILY_A, 1, 2), run(FAMILY_A, 2, 30),
    ...[3, 4, 5, 6, 7].map((n) => run(FAMILY_B, n, 5)),
  ]);
  db.seed('subscriptions', [
    // B's row first, so a read that forgot the household would find it.
    { family_id: FAMILY_B, plan: 'basic', status: 'active' },
    { family_id: FAMILY_A, plan: 'plus', status: 'active' },
  ]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('loadFamilyDeliveredValueAction', () => {
  it.each(ROLES)('ACTION-F28061A6CFAD signed in as %s, a member reads their own family\'s delivered value, counting none of B\'s runs', async (role) => {
    signInAs(role);
    const before = structuredClone({ runs: db.table('family_automation_runs'), subs: db.table('subscriptions') });

    expect(await loadFamilyDeliveredValueAction()).toEqual({
      familyId: FAMILY_A,
      result: { available: true, data: computeTimeSaved([{ kind: 'run', count: 2 }], 0) },
    });
    expect({ runs: db.table('family_automation_runs'), subs: db.table('subscriptions') }).toEqual(before);
  });

  it('ACTION-F28061A6CFAD a family id passed by the caller is ignored: the session\'s household is read', async () => {
    signInAs('child');
    const result = await (loadFamilyDeliveredValueAction as (...args: unknown[]) => ReturnType<typeof loadFamilyDeliveredValueAction>)(FAMILY_B);
    expect(result).toEqual({ familyId: FAMILY_A, result: { available: true, data: computeTimeSaved([{ kind: 'run', count: 2 }], 0) } });
  });
});
