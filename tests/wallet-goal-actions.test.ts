import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

/**
 * createGoalAction and fundGoalAction (app/(app)/wallet/actions.ts), run as
 * code rather than read as text. `wallet-goal-persistence.test.ts` pins the
 * source shape (the RPC is called, the action does not write the ledger
 * itself); this drives both actions against an in-memory store and a
 * synthetic `wallet_fund_goal` RPC, through the real `fundGoal` wrapper and the
 * real error wording, and asserts what each one writes, sends and answers.
 *
 * Register B: ACTION-A465DB1C3703 (createGoalAction), ACTION-9BA4E71ADEE9
 * (fundGoalAction).
 */

const FAMILY = 'family-1';
const harness = vi.hoisted(() => ({
  db: null as unknown,
  role: 'parent',
  rpc: null as null | ((args: Record<string, unknown>) => unknown),
  decision: { effect: 'allow', reason: 'Allowed.' } as Record<string, unknown>,
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
    user: { id: 'user-parent' },
    memberships: [],
    active: { familyId: FAMILY, role: harness.role, member: { id: 'member-self', family_id: FAMILY } },
  }),
  effectivePlanLevel: () => 0,
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

const { createGoalAction, fundGoalAction } = await import('@/app/(app)/wallet/actions');
const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
const { describeActionError } = await import('@/lib/supabase/errors');
const { householdPolicyBlocked } = await import('@/lib/trust/messages');
const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);

let db: InMemorySupabase;
let rpcCalls: Record<string, unknown>[];

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  rpcCalls = [];
  db = createInMemorySupabase({
    rpc: { wallet_fund_goal: (args) => { rpcCalls.push(args); return harness.rpc?.(args); } },
  });
  harness.db = db;
  harness.role = 'parent';
  harness.rpc = () => ({ ok: true, transaction_id: 'txn-1' });
  harness.decision = { effect: 'allow', reason: 'Allowed.' };
  harness.revalidatePath.mockClear();
  harness.evaluateTrust.mockClear();
  db.seed('wallet_goals', [
    { id: 'goal-1', family_id: FAMILY, child_wallet_id: 'wallet-1', title: 'New bike', kind: 'custom', target_cents: 20_000, saved_cents: 0 },
    { id: 'goal-elsewhere', family_id: 'family-2', child_wallet_id: 'wallet-9', title: 'Their goal', kind: 'custom', target_cents: 5_000, saved_cents: 0 },
  ]);
});

/** Every write the store answers for `table` fails with `error`; reads still work. */
function failWrites(table: string, error: Record<string, unknown>) {
  const from = db.from.bind(db);
  (db as unknown as { from: (name: string) => unknown }).from = (name: string) => {
    const builder = from(name);
    if (name !== table) return builder;
    (builder as unknown as { insert: () => unknown }).insert = () => ({
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: null, error, count: null, status: 403, statusText: 'Forbidden' }).then(resolve),
    });
    return builder;
  };
}

/** Every read of `table` fails with `error`. */
function failReads(table: string, error: Record<string, unknown>) {
  const from = db.from.bind(db);
  (db as unknown as { from: (name: string) => unknown }).from = (name: string) => {
    const builder = from(name);
    if (name !== table) return builder;
    (builder as unknown as { maybeSingle: () => unknown }).maybeSingle = async () => ({ data: null, error, count: null, status: 500, statusText: 'Internal Server Error' });
    return builder;
  };
}

const newGoals = () => db.table('wallet_goals').filter((g) => g.id !== 'goal-1' && g.id !== 'goal-elsewhere');

describe('createGoalAction (ACTION-A465DB1C3703)', () => {
  it('saves a family-wide goal for the parent’s own family, as the parent', async () => {
    expect(await createGoalAction({ title: '  Summer trip  ', targetCents: 50_000 })).toEqual({ ok: true });

    expect(newGoals()).toHaveLength(1);
    expect(newGoals()[0]).toMatchObject({
      family_id: FAMILY, child_wallet_id: null, title: 'Summer trip', kind: 'custom',
      target_cents: 50_000, target_date: null, created_by: 'user-parent',
    });
    expect(harness.revalidatePath).toHaveBeenCalledWith('/wallet/goals');
  });

  it('saves a child’s goal with its kind and date, and whole cents only', async () => {
    const result = await createGoalAction({ title: 'Lego set', kind: 'toy', targetCents: 4_999.9, childWalletId: 'wallet-1', targetDate: '2026-12-24' });

    expect(result).toEqual({ ok: true });
    expect(newGoals()[0]).toMatchObject({ family_id: FAMILY, child_wallet_id: 'wallet-1', kind: 'toy', target_cents: 4_999, target_date: '2026-12-24' });
  });

  it('lets an adult manager create one too', async () => {
    harness.role = 'adult';
    expect(await createGoalAction({ title: 'Tablet', targetCents: 30_000 })).toEqual({ ok: true });
    expect(newGoals()).toHaveLength(1);
  });

  it.each(['teen', 'child', 'caregiver', 'guest'])('refuses a %s and writes nothing', async (role) => {
    harness.role = role;
    expect(await createGoalAction({ title: 'Mine', targetCents: 1_000 })).toEqual({ ok: false, error: t('actions.onlyAParentGuardianCan7') });
    expect(newGoals()).toHaveLength(0);
    expect(db.log.map((entry) => entry.table)).not.toContain('wallet_goals');
    expect(harness.revalidatePath).not.toHaveBeenCalled();
  });

  it.each(['', '   ', '\n\t'])('refuses a goal with no name (%j)', async (title) => {
    expect(await createGoalAction({ title, targetCents: 1_000 })).toEqual({ ok: false, error: t('actions.giveTheGoalAName') });
    expect(newGoals()).toHaveLength(0);
  });

  it.each([0, -1, -5_000, 0.9, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'refuses a target of %s and writes nothing',
    async (targetCents) => {
      expect(await createGoalAction({ title: 'Bike', targetCents })).toEqual({ ok: false, error: t('actions.setATargetGreaterThan') });
      expect(newGoals()).toHaveLength(0);
      expect(harness.revalidatePath).not.toHaveBeenCalled();
    },
  );

  it('accepts the smallest target, one cent', async () => {
    expect(await createGoalAction({ title: 'Sticker', targetCents: 1 })).toEqual({ ok: true });
    expect(newGoals()[0]).toMatchObject({ target_cents: 1 });
  });

  it('reports a refused insert as a failure, in words, not the database’s own text', async () => {
    const error = { code: '42501', message: 'new row violates row-level security policy for table "wallet_goals"', details: null, hint: null };
    failWrites('wallet_goals', error);

    const result = await createGoalAction({ title: 'Bike', targetCents: 1_000 });

    expect(result).toEqual({ ok: false, error: describeActionError(error, t('actions.couldNotSaveThatWallet')) });
    expect(result.error).not.toContain('row-level security');
    expect(harness.revalidatePath).not.toHaveBeenCalled();
  });
});

describe('fundGoalAction (ACTION-9BA4E71ADEE9)', () => {
  it('funds the family’s goal through the atomic RPC, as the parent, and says so', async () => {
    expect(await fundGoalAction({ goalId: 'goal-1', amountCents: 1_234 })).toEqual({ ok: true });

    expect(rpcCalls).toEqual([{ p_family_id: FAMILY, p_goal_id: 'goal-1', p_amount: 1_234, p_actor_id: 'user-parent' }]);
    expect(harness.revalidatePath).toHaveBeenCalledWith('/wallet/goals');
    // The action itself writes neither the ledger nor the goal; the RPC does both.
    expect(db.log.map((entry) => entry.table)).toEqual(['wallet_goals']);
    expect(db.table('wallet_goals').find((g) => g.id === 'goal-1')).toMatchObject({ saved_cents: 0 });
  });

  it('asks the household policy first, as this member, for this amount', async () => {
    await fundGoalAction({ goalId: 'goal-1', amountCents: 1_234 });

    expect(harness.evaluateTrust).toHaveBeenCalledTimes(1);
    const [client, family, request] = harness.evaluateTrust.mock.calls[0] as [unknown, string, { title: string }];
    expect(client).toBe(db);
    expect(family).toBe(FAMILY);
    expect(request).toMatchObject({
      actor: { kind: 'member', id: 'member-self', role: 'parent' },
      domain: 'finances', capability: 'automate', context: { amountCents: 1_234 }, openApproval: false,
    });
    expect(request.title).toContain('New bike');
    expect(request.title).toContain('12.34');
  });

  it('sends whole cents only', async () => {
    expect(await fundGoalAction({ goalId: 'goal-1', amountCents: 1_999.9 })).toEqual({ ok: true });
    expect(rpcCalls[0]).toMatchObject({ p_amount: 1_999 });
  });

  it('accepts the smallest amount, one cent', async () => {
    expect(await fundGoalAction({ goalId: 'goal-1', amountCents: 1 })).toEqual({ ok: true });
    expect(rpcCalls[0]).toMatchObject({ p_amount: 1 });
  });

  it.each(['teen', 'child', 'caregiver', 'guest'])('refuses a %s before reading or moving anything', async (role) => {
    harness.role = role;
    expect(await fundGoalAction({ goalId: 'goal-1', amountCents: 500 })).toEqual({ ok: false, error: t('actions.onlyAParentGuardianCan8') });
    expect(db.log).toHaveLength(0);
    expect(harness.evaluateTrust).not.toHaveBeenCalled();
    expect(rpcCalls).toHaveLength(0);
  });

  it.each([0, -1, -500, 0.5, Number.NaN, Number.POSITIVE_INFINITY])('refuses an amount of %s and moves nothing', async (amountCents) => {
    expect(await fundGoalAction({ goalId: 'goal-1', amountCents })).toEqual({ ok: false, error: t('actions.enterAnAmountGreaterThan') });
    expect(rpcCalls).toHaveLength(0);
    expect(harness.revalidatePath).not.toHaveBeenCalled();
  });

  it('does not fund another family’s goal, and does not ask the policy about it', async () => {
    expect(await fundGoalAction({ goalId: 'goal-elsewhere', amountCents: 500 })).toEqual({ ok: false, error: t('actions.goalNotFound') });
    expect(rpcCalls).toHaveLength(0);
    expect(harness.evaluateTrust).not.toHaveBeenCalled();
  });

  it('does not fund a goal that does not exist', async () => {
    expect(await fundGoalAction({ goalId: 'goal-missing', amountCents: 500 })).toEqual({ ok: false, error: t('actions.goalNotFound') });
    expect(rpcCalls).toHaveLength(0);
  });

  it('fails closed when the goal cannot be read', async () => {
    const error = { code: '57014', message: 'canceling statement due to statement timeout', details: null, hint: null };
    failReads('wallet_goals', error);

    expect(await fundGoalAction({ goalId: 'goal-1', amountCents: 500 })).toEqual({ ok: false, error: describeActionError(error, t('actions.couldNotLoadThatSavings')) });
    expect(rpcCalls).toHaveLength(0);
    expect(harness.evaluateTrust).not.toHaveBeenCalled();
  });

  it('moves nothing when the household policy denies it, and says why in the reader’s language', async () => {
    harness.decision = { effect: 'deny', reason: 'Blocked by policy: Finances.', reasonKey: 'trust.denyBlockedByPolicy', reasonParams: { domain: 'finances' }, basis: 'policy' };

    const result = await fundGoalAction({ goalId: 'goal-1', amountCents: 500 });

    expect(result).toEqual({ ok: false, error: householdPolicyBlocked(t, harness.decision as Parameters<typeof householdPolicyBlocked>[1]) });
    expect(result.error).toContain('Blocked by household policy');
    expect(rpcCalls).toHaveLength(0);
    expect(harness.revalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    [{ ok: false, reason: 'insufficient_funds', available: 250 }, 'Only 2.50 is available.'],
    [{ ok: false, reason: 'goal_wallet_required' }, 'That goal needs a child wallet before it can be funded.'],
    [{ ok: false, reason: 'save_bucket_missing' }, 'The wallet Save bucket is unavailable.'],
    [{ ok: false, reason: 'forbidden' }, 'You are not allowed to manage this family wallet.'],
    [{ ok: false, reason: 'something_new' }, 'Could not fund that goal.'],
    [null, 'Could not fund that goal.'],
  ])('reports the RPC refusing (%j) as a failure, and does not claim success', async (answer, message) => {
    harness.rpc = () => answer;

    expect(await fundGoalAction({ goalId: 'goal-1', amountCents: 500 })).toEqual({ ok: false, error: message });
    expect(rpcCalls).toHaveLength(1);
    expect(harness.revalidatePath).not.toHaveBeenCalled();
  });

  it('reports the RPC failing outright without passing on the database’s text', async () => {
    harness.rpc = () => { throw new Error('deadlock detected'); };

    const result = await fundGoalAction({ goalId: 'goal-1', amountCents: 500 });

    expect(result.ok).toBe(false);
    expect(result.error).not.toContain('deadlock');
    expect(harness.revalidatePath).not.toHaveBeenCalled();
  });
});
