import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

/**
 * A Trust answer that is not "allow" moves no money.
 *
 * `runDueAllowancesAction`, `payChoreRewardAction` and
 * `recordBabysitterPaymentAction` each ask the Trust Engine with
 * `openApproval: false` and stopped only on `effect === 'deny'`. Everything
 * else was taken as permission, including the two answers that mean "not
 * without a person saying yes":
 *
 * - a household policy that requires approval (for example two parents), and
 * - `basis: 'degraded'`, which the bridge returns when it cannot read the
 *   family's policies or grants, precisely so that a lost rule is asked about
 *   rather than assumed (lib/trust/server.ts).
 *
 * With nothing opened and nothing held, the credit simply completed: the
 * trust ledger said `require_approval` while the wallet said "paid". None of
 * the three has an approval route to wait on, so each now refuses, in the
 * household-policy words, unless the answer is `allow`. Nothing is credited,
 * claimed, recorded, audited or refreshed, and no approval card is filed for
 * an approval that would have nothing to execute.
 *
 * This runs the REAL Trust bridge (`evaluateTrust` → `loadTrustInputs` →
 * `evaluateAction` → the audit write) over the in-memory store; the spy only
 * records what it returned. Review: #697 comment 5918705774.
 */

const FAMILY = 'family-1';
const TODAY = '2026-09-28';
const harness = vi.hoisted(() => ({
  db: null as unknown,
  role: 'parent',
  revalidatePath: null as unknown as Mock<(...args: unknown[]) => unknown>,
  evaluateTrust: null as unknown as Mock<(...args: unknown[]) => unknown>,
}));

vi.mock('next/cache', async () => {
  const { vi: v } = await import('vitest');
  harness.revalidatePath = v.fn();
  return { revalidatePath: (...args: unknown[]) => harness.revalidatePath(...args) };
});
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-self' },
    memberships: [],
    active: {
      familyId: FAMILY, role: harness.role,
      member: { id: 'member-self', family_id: FAMILY },
      family: { id: FAMILY, timezone: 'UTC' },
    },
  }),
  effectivePlanLevel: async (level: number) => level,
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db, createServiceClient: () => harness.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});
// Not a stub: every call goes to the real bridge. The spy keeps its answer.
vi.mock('@/lib/trust/server', async (importOriginal) => {
  const { vi: v } = await import('vitest');
  const actual = await importOriginal<typeof import('@/lib/trust/server')>();
  harness.evaluateTrust = v.fn(actual.evaluateTrust) as unknown as typeof harness.evaluateTrust;
  return { ...actual, evaluateTrust: (...args: unknown[]) => harness.evaluateTrust(...args) };
});

const { runDueAllowancesAction, payChoreRewardAction, recordBabysitterPaymentAction } = await import('@/app/(app)/wallet/actions');
const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
const { householdPolicyBlocked } = await import('@/lib/trust/messages');
const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
type Decision = Parameters<typeof householdPolicyBlocked>[1] & { effect: string; basis?: string; requiredApprovals?: number };

const PG_ERROR = { code: '57014', message: 'canceling statement due to statement timeout', details: null, hint: null };
const KINDS = ['spend', 'save', 'give', 'invest'] as const;
/** Every table a refused credit must leave exactly as it found it. */
const MONEY_TABLES = ['wallet_transactions', 'allowance_rules', 'chore_assignments', 'babysitter_payments', 'wallet_audit_logs', 'approval_requests'];

let db: InMemorySupabase;

const policy = (over: Row = {}): Row => ({
  id: 'policy-1', family_id: FAMILY, name: 'Money needs approval', enabled: true,
  domain: 'finances', capability: 'automate', subject_kind: 'everyone', subject_role: null, subject_member_id: null,
  effect: 'require_approval', conditions: {}, approval_model: 'single', required_approvals: 1, priority: 100,
  created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z',
  ...over,
});
const TWO_PARENTS = policy({ id: 'policy-two-parents', approval_model: 'two_parent', required_approvals: 2 });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${TODAY}T12:00:00.000Z`));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase();
  harness.db = db;
  harness.role = 'parent';
  harness.revalidatePath.mockClear();
  harness.evaluateTrust.mockClear();
  db.seed('families', [{ id: FAMILY, trial_ends_at: null, closed_at: null }]);
  db.seed('subscriptions', [{ family_id: FAMILY, plan: 'basic', status: 'active' }]);
  db.seed('child_wallets', [{ id: 'wallet-a', family_id: FAMILY, member_id: 'member-a' }]);
  db.seed('wallet_buckets', KINDS.map((kind) => ({ id: `wallet-a-${kind}`, family_id: FAMILY, child_wallet_id: 'wallet-a', kind })));
  db.seed('allowance_rules', [
    { id: 'rule-due', family_id: FAMILY, child_wallet_id: 'wallet-a', amount_cents: 1_500, cadence: 'weekly', split: null, is_active: true, next_run_on: TODAY, last_run_on: '2026-09-21' },
  ]);
  db.seed('chores', [{ id: 'chore-cash', family_id: FAMILY, title: 'Mow the lawn', cash_cents: 1_500 }]);
  db.seed('chore_assignments', [
    { id: 'asg-1', family_id: FAMILY, member_id: 'member-a', chore_id: 'chore-cash', cash_awarded_cents: null, status: 'approved' },
  ]);
  db.seed('babysitter_profiles', [{ id: 'sitter-own', family_id: FAMILY, name: 'Ava', is_active: true }]);
});

afterEach(() => { vi.useRealTimers(); });

const ACTIONS = [
  {
    name: 'runDueAllowancesAction',
    run: () => runDueAllowancesAction(),
    paid: { ok: true, ranCount: 1, paidCents: 1_500 },
    recorded: () => db.table('wallet_transactions'),
  },
  {
    name: 'payChoreRewardAction',
    run: () => payChoreRewardAction({ choreAssignmentId: 'asg-1' }),
    paid: { ok: true },
    recorded: () => db.table('wallet_transactions'),
  },
  {
    name: 'recordBabysitterPaymentAction',
    run: () => recordBabysitterPaymentAction({ babysitterId: 'sitter-own', hours: 3, rateCents: 500, tipCents: 0, amountCents: 1_500 }),
    paid: { ok: true },
    recorded: () => db.table('babysitter_payments'),
  },
] as const;

const snapshot = () => structuredClone(Object.fromEntries(MONEY_TABLES.map((name) => [name, db.table(name)])));

/** What the real bridge answered on its one call. */
async function trustAnswered(): Promise<Decision> {
  expect(harness.evaluateTrust).toHaveBeenCalledTimes(1);
  return ((await harness.evaluateTrust.mock.results[0].value) as { decision: Decision }).decision;
}

/** Make one table's awaited read answer a database error, keeping every other table real. */
function failRead(table: string) {
  const from = db.from.bind(db);
  (db as unknown as { from: (name: string) => unknown }).from = (name: string) => {
    const builder = from(name) as unknown as Record<string, unknown>;
    if (name === table) {
      builder.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve({ data: null, error: PG_ERROR, count: null, status: 500, statusText: 'Error' }).then(resolve, reject);
    }
    return builder;
  };
}

describe.each(ACTIONS)('$name credits only on a Trust "allow"', ({ run, paid, recorded }) => {
  describe('refused, with nothing credited, claimed, recorded or filed', () => {
    const cases: [string, () => void, Partial<Decision>][] = [
      ['a household policy that needs two parents', () => db.seed('trust_policies', [TWO_PARENTS]),
        { effect: 'require_approval', basis: 'policy', requiredApprovals: 2 }],
      ['a household policy that needs one approval', () => db.seed('trust_policies', [policy()]),
        { effect: 'require_approval', basis: 'policy', requiredApprovals: 1 }],
      ['the family’s policies cannot be read', () => failRead('trust_policies'),
        { effect: 'require_approval', basis: 'degraded' }],
      ['the family’s grants cannot be read', () => failRead('permission_grants'),
        { effect: 'require_approval', basis: 'degraded' }],
    ];

    it.each(cases)('%s', async (_label, arrange, expected) => {
      arrange();
      const before = snapshot();

      const result = await run();

      const decision = await trustAnswered();
      expect(decision).toMatchObject(expected);
      expect(result).toEqual({ ok: false, error: householdPolicyBlocked(t, decision) });
      expect(snapshot()).toEqual(before);
      expect(recorded()).toHaveLength(0);
      expect(harness.revalidatePath).not.toHaveBeenCalled();
      // The Trust ledger says what was decided, and it was not a yes.
      expect(db.table('trust_audit_logs')).toEqual([expect.objectContaining({ family_id: FAMILY, decision: 'require_approval' })]);
    });

    it('an explicit household denial, as before', async () => {
      db.seed('trust_policies', [policy({ effect: 'deny' })]);
      const before = snapshot();

      const result = await run();

      const decision = await trustAnswered();
      expect(decision).toMatchObject({ effect: 'deny', basis: 'policy' });
      expect(result).toEqual({ ok: false, error: householdPolicyBlocked(t, decision) });
      expect(snapshot()).toEqual(before);
    });
  });

  describe('still credited on a real "allow"', () => {
    it('a parent, by role default, with no policies', async () => {
      expect(await run()).toEqual(paid);
      expect(await trustAnswered()).toMatchObject({ effect: 'allow', basis: 'role_default' });
      expect(recorded().length).toBeGreaterThan(0);
    });

    it('an adult, by role default', async () => {
      harness.role = 'adult';
      expect(await run()).toEqual(paid);
      expect(await trustAnswered()).toMatchObject({ effect: 'allow', basis: 'role_default' });
    });

    it('a household policy that allows it', async () => {
      db.seed('trust_policies', [policy({ effect: 'allow' })]);
      expect(await run()).toEqual(paid);
      expect(await trustAnswered()).toMatchObject({ effect: 'allow', basis: 'policy' });
    });

    it('an approval policy for another area of family life, another family, or switched off', async () => {
      db.seed('trust_policies', [
        policy({ id: 'policy-medical', domain: 'medical' }),
        { ...TWO_PARENTS, id: 'policy-other-family', family_id: 'family-2' },
        { ...TWO_PARENTS, id: 'policy-disabled', enabled: false },
      ]);
      expect(await run()).toEqual(paid);
      expect(await trustAnswered()).toMatchObject({ effect: 'allow', basis: 'role_default' });
    });
  });
});
