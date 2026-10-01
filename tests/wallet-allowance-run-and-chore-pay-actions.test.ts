import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

/**
 * runDueAllowancesAction and payChoreRewardAction (app/(app)/wallet/actions.ts),
 * run as code. `manual-allowance-run-claims-like-the-cron.test.ts` and
 * `allowance-cron-idempotency.test.ts` read the run's source text; nothing ran
 * either action. This drives both against the in-memory store, through the
 * real `creditChildWallet` (split allocation and ledger rows), the real plan
 * resolution, the real schedule arithmetic and the real message catalogue,
 * and asserts what each one claims, credits, advances and answers.
 *
 * Finding: MAIN-F-F07 (money server actions with no test). Register B:
 * ACTION-14F1D3BFB97A (runDueAllowancesAction), ACTION-DD0EECD42C71
 * (payChoreRewardAction).
 *
 * The clock is pinned to 2026-09-28T12:00Z and the family is on Basic in UTC.
 * Mocked: the session, `next/cache` and `evaluateTrust`. Row-level security,
 * `uq_wallet_txn_chore_payout` (0316) and the cron itself are not exercised;
 * the unique index's answer is stubbed where a case needs it.
 */

const FAMILY = 'family-1';
const TODAY = '2026-09-28';
const harness = vi.hoisted(() => ({
  db: null as unknown,
  role: 'parent',
  decision: { effect: 'allow', reason: 'Allowed.', basis: 'role_default' } as Record<string, unknown>,
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
vi.mock('@/lib/trust/server', async (importOriginal) => {
  const { vi: v } = await import('vitest');
  harness.evaluateTrust = v.fn(async () => ({ decision: harness.decision }));
  return { ...(await importOriginal<typeof import('@/lib/trust/server')>()), evaluateTrust: (...args: unknown[]) => harness.evaluateTrust(...args) };
});

const { runDueAllowancesAction, payChoreRewardAction } = await import('@/app/(app)/wallet/actions');
const { creditChildWallet } = await import('@/lib/wallet/server');
const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
const { describeActionError } = await import('@/lib/supabase/errors');
const { householdPolicyBlocked } = await import('@/lib/trust/messages');
const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);

const NON_MANAGERS = ['teen', 'child', 'caregiver', 'guest'];
const DENY_POLICY = { effect: 'deny', reason: 'Blocked by policy: Finances.', reasonKey: 'trust.denyBlockedByPolicy', reasonParams: { domain: 'finances' }, basis: 'policy' } as const;
const PG_ERROR = { code: '57014', message: 'canceling statement due to statement timeout', details: null, hint: null };
const KINDS = ['spend', 'save', 'give', 'invest'] as const;

let db: InMemorySupabase;

const buckets = (walletId: string, family = FAMILY) => KINDS.map((kind) => ({ id: `${walletId}-${kind}`, family_id: family, child_wallet_id: walletId, kind }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${TODAY}T12:00:00.000Z`));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase();
  harness.db = db;
  harness.role = 'parent';
  harness.decision = { effect: 'allow', reason: 'Allowed.', basis: 'role_default' };
  harness.revalidatePath.mockClear();
  harness.evaluateTrust.mockClear();
  db.seed('families', [{ id: FAMILY, trial_ends_at: null, closed_at: null }, { id: 'family-2', trial_ends_at: null, closed_at: null }]);
  db.seed('subscriptions', [{ family_id: FAMILY, plan: 'basic', status: 'active' }, { family_id: 'family-2', plan: 'basic', status: 'active' }]);
  db.seed('child_wallets', [
    { id: 'wallet-a', family_id: FAMILY, member_id: 'member-a' },
    { id: 'wallet-b', family_id: FAMILY, member_id: 'member-b' },
    { id: 'wallet-x', family_id: 'family-2', member_id: 'member-x' },
    { id: 'wallet-z2', family_id: 'family-2', member_id: 'member-z' },
  ]);
  db.seed('wallet_buckets', [...buckets('wallet-a'), ...buckets('wallet-b'), ...buckets('wallet-x', 'family-2'), ...buckets('wallet-z2', 'family-2')]);
});

afterEach(() => { vi.useRealTimers(); });

const ledger = () => db.table('wallet_transactions');
const creditsTo = (walletId: string) => ledger().filter((row) => row.child_wallet_id === walletId);
const total = (rows: Row[]) => rows.reduce((sum, row) => sum + Number(row.amount_cents), 0);
const byBucket = (rows: Row[]) => Object.fromEntries(rows.map((row) => [row.bucket_id, row.amount_cents]));

/** Wrap one table's builder so a test can intercept a method, keeping the rest real. */
function intercept(table: string, patch: (builder: Record<string, unknown>) => void) {
  const from = db.from.bind(db);
  (db as unknown as { from: (name: string) => unknown }).from = (name: string) => {
    const builder = from(name) as unknown as Record<string, unknown>;
    if (name === table) patch(builder);
    return builder;
  };
}
const answer = (reply: Record<string, unknown>) => ({ data: null, count: null, status: 500, statusText: 'Error', ...reply });
const settled = (reply: Record<string, unknown>) => ({ then: (resolve: (v: unknown) => unknown) => Promise.resolve(answer(reply)).then(resolve) });

describe('runDueAllowancesAction (ACTION-14F1D3BFB97A)', () => {
  beforeEach(() => {
    db.seed('allowance_rules', [
      { id: 'rule-due-a', family_id: FAMILY, child_wallet_id: 'wallet-a', amount_cents: 1_000, cadence: 'weekly', split: null, is_active: true, next_run_on: TODAY, last_run_on: '2026-09-21' },
      { id: 'rule-due-b', family_id: FAMILY, child_wallet_id: 'wallet-b', amount_cents: 500, cadence: 'monthly', split: { spend: 100, save: 0, give: 0, invest: 0 }, is_active: true, next_run_on: '2026-09-01', last_run_on: '2026-08-01' },
      { id: 'rule-future', family_id: FAMILY, child_wallet_id: 'wallet-a', amount_cents: 700, cadence: 'weekly', split: null, is_active: true, next_run_on: '2026-09-29', last_run_on: '2026-09-22' },
      { id: 'rule-paused', family_id: FAMILY, child_wallet_id: 'wallet-b', amount_cents: 900, cadence: 'weekly', split: null, is_active: false, next_run_on: '2026-09-01', last_run_on: null },
      { id: 'rule-x', family_id: 'family-2', child_wallet_id: 'wallet-x', amount_cents: 1_100, cadence: 'weekly', split: null, is_active: true, next_run_on: TODAY, last_run_on: null },
    ]);
  });

  const rule = (id: string) => db.table('allowance_rules').find((row) => row.id === id) as Row;
  const untouched = () => structuredClone(db.table('allowance_rules').filter((row) => !['rule-due-a', 'rule-due-b'].includes(String(row.id))));

  it('pays every due, active rule of the family once, by its split, advances each schedule, and says how much', async () => {
    const others = untouched();

    expect(await runDueAllowancesAction()).toEqual({ ok: true, ranCount: 2, paidCents: 1_500 });

    expect(byBucket(creditsTo('wallet-a'))).toEqual({ 'wallet-a-spend': 400, 'wallet-a-save': 400, 'wallet-a-give': 100, 'wallet-a-invest': 100 });
    expect(byBucket(creditsTo('wallet-b'))).toEqual({ 'wallet-b-spend': 500 });
    for (const row of ledger()) {
      expect(row).toMatchObject({ family_id: FAMILY, type: 'allowance', status: 'completed', direction: 'credit', related_type: 'allowance_rules', created_by: 'user-self' });
    }
    expect(new Set(creditsTo('wallet-a').map((row) => row.related_id))).toEqual(new Set(['rule-due-a']));
    expect(new Set(creditsTo('wallet-b').map((row) => row.related_id))).toEqual(new Set(['rule-due-b']));

    expect(rule('rule-due-a')).toMatchObject({ next_run_on: '2026-10-05', last_run_on: TODAY });
    expect(rule('rule-due-b')).toMatchObject({ next_run_on: '2026-10-01', last_run_on: TODAY });
    expect(db.table('allowance_rules').filter((row) => !['rule-due-a', 'rule-due-b'].includes(String(row.id)))).toEqual(others);
    expect(creditsTo('wallet-x')).toHaveLength(0);

    expect(harness.revalidatePath).toHaveBeenCalledWith('/wallet/allowance');
    expect(harness.revalidatePath).toHaveBeenCalledWith('/wallet');
  });

  it('run twice, pays once: the second run finds nothing due', async () => {
    await runDueAllowancesAction();
    const paid = ledger().length;

    expect(await runDueAllowancesAction()).toEqual({ ok: true, ranCount: 0, paidCents: 0 });
    expect(ledger()).toHaveLength(paid);
  });

  it('with nothing due, pays nothing and asks nobody', async () => {
    db.replace('allowance_rules', db.table('allowance_rules').filter((row) => !String(row.id).startsWith('rule-due')));

    expect(await runDueAllowancesAction()).toEqual({ ok: true, ranCount: 0, paidCents: 0 });
    expect(ledger()).toHaveLength(0);
    expect(harness.evaluateTrust).not.toHaveBeenCalled();
  });

  it('asks the Trust Engine once for the whole batch, as the member, for the total', async () => {
    await runDueAllowancesAction();

    expect(harness.evaluateTrust).toHaveBeenCalledTimes(1);
    const [client, family, request] = harness.evaluateTrust.mock.calls[0] as [unknown, string, Record<string, unknown>];
    expect(client).toBe(db);
    expect(family).toBe(FAMILY);
    expect(request).toMatchObject({
      actor: { kind: 'member', id: 'member-self', role: 'parent' },
      domain: 'finances', capability: 'automate', context: { amountCents: 1_500 }, openApproval: false,
    });
  });

  it('a Trust denial pays nothing and claims nothing', async () => {
    harness.decision = DENY_POLICY;
    const before = structuredClone(db.table('allowance_rules'));

    expect(await runDueAllowancesAction()).toEqual({ ok: false, error: householdPolicyBlocked(t, DENY_POLICY as never) });
    expect(ledger()).toHaveLength(0);
    expect(db.table('allowance_rules')).toEqual(before);
  });

  // This case used to assert that the run went ahead, which pinned the defect
  // in #697 review 5918705774. The real bridge's policy and degraded answers
  // are run in a-money-credit-waits-for-a-trust-allow.test.ts.
  it('a Trust answer that asks for approval pays nothing and claims nothing', async () => {
    const needsApproval = { effect: 'require_approval', reason: 'Needs a second parent.', basis: 'policy' };
    harness.decision = needsApproval;
    const before = structuredClone(db.table('allowance_rules'));

    expect(await runDueAllowancesAction()).toEqual({ ok: false, error: householdPolicyBlocked(t, needsApproval as never) });
    expect(ledger()).toHaveLength(0);
    expect(db.table('allowance_rules')).toEqual(before);
  });

  it('a rule another run has just claimed is skipped, not paid twice', async () => {
    // Between this run's read and its claim, the cron moves rule-due-a on.
    let moved = false;
    intercept('allowance_rules', (builder) => {
      const update = (builder.update as (patch: Row) => unknown).bind(builder);
      builder.update = (patch: Row) => {
        if (!moved) { moved = true; rule('rule-due-a').next_run_on = '2026-10-05'; }
        return update(patch);
      };
    });

    expect(await runDueAllowancesAction()).toEqual({ ok: true, ranCount: 1, paidCents: 500 });
    expect(creditsTo('wallet-a')).toHaveLength(0);
    expect(total(creditsTo('wallet-b'))).toBe(500);
  });

  it('a credit that fails puts that rule’s schedule back, and reports how far the run got', async () => {
    db.replace('wallet_buckets', db.table('wallet_buckets').filter((row) => row.child_wallet_id !== 'wallet-b'));
    const side = createInMemorySupabase();
    const expected = await creditChildWallet(side as unknown as Parameters<typeof creditChildWallet>[0], {
      familyId: FAMILY, childWalletId: 'wallet-b', amountCents: 500, type: 'allowance', description: 'x', createdBy: 'user-self',
    });

    expect(await runDueAllowancesAction()).toEqual({ ok: false, error: expected.error, ranCount: 1, paidCents: 1_000 });
    expect(rule('rule-due-b')).toMatchObject({ next_run_on: '2026-09-01', last_run_on: '2026-08-01' });
    expect(creditsTo('wallet-b')).toHaveLength(0);
    expect(total(creditsTo('wallet-a'))).toBe(1_000);
    expect(harness.revalidatePath).not.toHaveBeenCalled();
  });

  it('a schedule that cannot be put back after a failed credit is logged: that run may be skipped', async () => {
    db.replace('wallet_buckets', db.table('wallet_buckets').filter((row) => row.child_wallet_id !== 'wallet-b'));
    let updates = 0;
    intercept('allowance_rules', (builder) => {
      const update = (builder.update as (patch: Row) => unknown).bind(builder);
      builder.update = (patch: Row) => {
        updates += 1;
        // 1: claim a, 2: claim b, 3: the rollback of b matches nothing.
        if (updates === 3) { const chain = { eq: () => chain, select: () => settled({ data: [], error: null, status: 200 }) }; return chain; }
        return update(patch);
      };
    });

    expect((await runDueAllowancesAction()).ok).toBe(false);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('a run may be skipped'),
      expect.objectContaining({ ruleId: 'rule-due-b', familyId: FAMILY, error: 'no rows updated' }),
    );
  });

  it('a failed read of the due rules is a failure in words', async () => {
    intercept('allowance_rules', (builder) => { builder.lte = () => settled({ error: PG_ERROR }); });

    expect(await runDueAllowancesAction()).toEqual({ ok: false, error: describeActionError(PG_ERROR, t('actions.couldNotLoadDueAllowances')) });
    expect(ledger()).toHaveLength(0);
  });

  it('a failed claim stops the run in words, before that rule is paid', async () => {
    intercept('allowance_rules', (builder) => {
      builder.update = () => { const chain = { eq: () => chain, lte: () => chain, select: () => ({ maybeSingle: async () => answer({ error: PG_ERROR }) }) }; return chain; };
    });

    expect(await runDueAllowancesAction()).toEqual({ ok: false, error: describeActionError(PG_ERROR, t('wallet.couldNotUpdateAnAllowanceSchedule')) });
    expect(ledger()).toHaveLength(0);
  });

  it.each(NON_MANAGERS)('refuses a %s before reading anything', async (role) => {
    harness.role = role;

    expect(await runDueAllowancesAction()).toEqual({ ok: false, error: t('actions.onlyAParentGuardianCan6') });
    expect(db.log).toHaveLength(0);
  });

  it('a family without Basic is told so, and nothing is paid or claimed', async () => {
    db.replace('subscriptions', []);
    const before = structuredClone(db.table('allowance_rules'));

    expect(await runDueAllowancesAction()).toEqual({ ok: false, error: t('actions.automatedAllowancesAreABasic') });
    expect(ledger()).toHaveLength(0);
    expect(db.table('allowance_rules')).toEqual(before);
  });
});

describe('payChoreRewardAction (ACTION-DD0EECD42C71)', () => {
  beforeEach(() => {
    db.seed('chores', [
      { id: 'chore-cash', family_id: FAMILY, title: 'Mow the lawn', cash_cents: 1_500 },
      { id: 'chore-nocash', family_id: FAMILY, title: 'Make the bed', cash_cents: null },
      { id: 'chore-x', family_id: 'family-2', title: 'Walk the dog', cash_cents: 900 },
    ]);
    db.seed('chore_assignments', [
      { id: 'asg-1', family_id: FAMILY, member_id: 'member-a', chore_id: 'chore-cash', cash_awarded_cents: null, status: 'approved' },
      { id: 'asg-awarded', family_id: FAMILY, member_id: 'member-a', chore_id: 'chore-cash', cash_awarded_cents: 2_200, status: 'approved' },
      { id: 'asg-nocash', family_id: FAMILY, member_id: 'member-a', chore_id: 'chore-nocash', cash_awarded_cents: null, status: 'approved' },
      { id: 'asg-nowallet', family_id: FAMILY, member_id: 'member-z', chore_id: 'chore-cash', cash_awarded_cents: null, status: 'approved' },
      { id: 'asg-x', family_id: 'family-2', member_id: 'member-x', chore_id: 'chore-x', cash_awarded_cents: null, status: 'approved' },
    ]);
  });

  const pay = (choreAssignmentId = 'asg-1') => payChoreRewardAction({ choreAssignmentId });

  it('credits the child’s wallet with the chore’s cash, by the default split, once, tied to the assignment', async () => {
    expect(await pay()).toEqual({ ok: true });

    expect(byBucket(creditsTo('wallet-a'))).toEqual({ 'wallet-a-spend': 600, 'wallet-a-save': 600, 'wallet-a-give': 150, 'wallet-a-invest': 150 });
    for (const row of ledger()) {
      expect(row).toMatchObject({
        family_id: FAMILY, child_wallet_id: 'wallet-a', type: 'chore_reward', status: 'completed', direction: 'credit',
        related_type: 'chore_assignments', related_id: 'asg-1', created_by: 'user-self',
      });
      expect(String(row.description)).toContain('Mow the lawn');
    }
    expect(harness.revalidatePath).toHaveBeenCalledTimes(1);
    expect(harness.revalidatePath).toHaveBeenCalledWith('/wallet');
  });

  it('an adult may pay too', async () => {
    harness.role = 'adult';
    expect(await pay()).toEqual({ ok: true });
    expect(total(ledger())).toBe(1_500);
  });

  it('the amount awarded at approval wins over the chore’s listed cash', async () => {
    expect(await pay('asg-awarded')).toEqual({ ok: true });
    expect(total(ledger())).toBe(2_200);
  });

  it('follows the child’s own split rule', async () => {
    db.seed('wallet_rules', [{ family_id: FAMILY, child_wallet_id: 'wallet-a', split: { spend: 100, save: 0, give: 0, invest: 0 } }]);
    expect(await pay()).toEqual({ ok: true });
    expect(byBucket(ledger())).toEqual({ 'wallet-a-spend': 1_500 });
  });

  it('asks the Trust Engine as the member, about finances, for the reward', async () => {
    await pay();

    expect(harness.evaluateTrust).toHaveBeenCalledTimes(1);
    const [client, family, request] = harness.evaluateTrust.mock.calls[0] as [unknown, string, Record<string, unknown>];
    expect(client).toBe(db);
    expect(family).toBe(FAMILY);
    expect(request).toMatchObject({
      actor: { kind: 'member', id: 'member-self', role: 'parent' },
      domain: 'finances', capability: 'automate', context: { amountCents: 1_500 }, openApproval: false,
    });
  });

  it('a Trust denial pays nothing', async () => {
    harness.decision = DENY_POLICY;

    expect(await pay()).toEqual({ ok: false, error: householdPolicyBlocked(t, DENY_POLICY as never) });
    expect(ledger()).toHaveLength(0);
    expect(harness.revalidatePath).not.toHaveBeenCalled();
  });

  // Replaced for the same reason as the run's case above.
  it('a Trust answer that asks for approval pays nothing', async () => {
    const needsApproval = { effect: 'require_approval', reason: 'Needs a second parent.', basis: 'policy' };
    harness.decision = needsApproval;

    expect(await pay()).toEqual({ ok: false, error: householdPolicyBlocked(t, needsApproval as never) });
    expect(ledger()).toHaveLength(0);
    expect(harness.revalidatePath).not.toHaveBeenCalled();
  });

  describe('paid once', () => {
    it('a chore already paid is said to be, and is not paid again or put to Trust', async () => {
      await pay();
      const paid = ledger().length;
      harness.evaluateTrust.mockClear();

      expect(await pay()).toEqual({ ok: false, error: t('actions.thisChoreWasAlreadyPaid') });
      expect(ledger()).toHaveLength(paid);
      expect(harness.evaluateTrust).not.toHaveBeenCalled();
    });

    it('another chore’s payout is not taken for this one’s', async () => {
      expect(await pay('asg-awarded')).toEqual({ ok: true });

      expect(await pay('asg-1')).toEqual({ ok: true });
      expect(total(ledger().filter((row) => row.related_id === 'asg-1'))).toBe(1_500);
    });

    it('the loser of a double click, refused by the unique index, is told "already paid", not a database error', async () => {
      const duplicate = { code: '23505', message: 'duplicate key value violates unique constraint "uq_wallet_txn_chore_payout"', details: null, hint: null };
      intercept('wallet_transactions', (builder) => { builder.insert = () => settled({ error: duplicate }); });

      expect(await pay()).toEqual({ ok: false, error: t('actions.thisChoreWasAlreadyPaid') });
      expect(harness.revalidatePath).not.toHaveBeenCalled();
    });

    it('when it cannot tell whether the chore was paid, it does not pay', async () => {
      intercept('wallet_transactions', (builder) => { builder.limit = () => settled({ error: PG_ERROR }); });

      expect(await pay()).toEqual({ ok: false, error: describeActionError(PG_ERROR, t('actions.couldNotVerifyWhetherThat')) });
      expect(harness.evaluateTrust).not.toHaveBeenCalled();
    });
  });

  describe('what it refuses', () => {
    it.each(NON_MANAGERS)('a %s, before reading anything', async (role) => {
      harness.role = role;

      expect(await pay()).toEqual({ ok: false, error: t('actions.onlyAParentGuardianCan3') });
      expect(db.log).toHaveLength(0);
    });

    it.each([
      ['another family’s assignment', 'asg-x'],
      ['an assignment that does not exist', 'asg-missing'],
    ])('%s is not found, and nothing else is read', async (_label, id) => {
      expect(await pay(id)).toEqual({ ok: false, error: t('actions.choreNotFound') });
      expect(db.log.map((entry) => entry.table)).toEqual(['chore_assignments']);
      expect(ledger()).toHaveLength(0);
    });

    it('a chore with no cash reward, before the ledger is read', async () => {
      expect(await pay('asg-nocash')).toEqual({ ok: false, error: t('actions.thisChoreHasNoCash') });
      expect(db.log.map((entry) => entry.table)).toEqual(['chore_assignments']);
    });

    it('a child with no wallet in this family, even if a wallet elsewhere carries the same member', async () => {
      expect(await pay('asg-nowallet')).toEqual({ ok: false, error: t('actions.thisChildHasNoWallet') });
      expect(creditsTo('wallet-z2')).toHaveLength(0);
      expect(harness.evaluateTrust).not.toHaveBeenCalled();
    });

    it('a failed assignment read, in words', async () => {
      intercept('chore_assignments', (builder) => { builder.maybeSingle = async () => answer({ error: PG_ERROR }); });
      expect(await pay()).toEqual({ ok: false, error: describeActionError(PG_ERROR, t('actions.couldNotLoadThatChore')) });
    });

    it('a failed wallet read, in words', async () => {
      intercept('child_wallets', (builder) => { builder.maybeSingle = async () => answer({ error: PG_ERROR }); });
      expect(await pay()).toEqual({ ok: false, error: describeActionError(PG_ERROR, t('actions.couldNotLoadTheChild')) });
      expect(ledger()).toHaveLength(0);
    });

    it('a credit that fails passes on the ledger helper’s answer, and refreshes nothing', async () => {
      db.replace('wallet_buckets', db.table('wallet_buckets').filter((row) => row.child_wallet_id !== 'wallet-a'));
      const side = createInMemorySupabase();
      const expected = await creditChildWallet(side as unknown as Parameters<typeof creditChildWallet>[0], {
        familyId: FAMILY, childWalletId: 'wallet-a', amountCents: 1_500, type: 'chore_reward', description: 'x', createdBy: 'user-self',
      });

      expect(await pay()).toEqual({ ok: false, error: expected.error });
      expect(ledger()).toHaveLength(0);
      expect(harness.revalidatePath).not.toHaveBeenCalled();
    });
  });
});
