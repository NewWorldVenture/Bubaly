import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

/**
 * addFundsAction and sendMoneyAction (app/(app)/wallet/actions.ts), run as
 * code. `wallet-atomic-persistence.test.ts` and
 * `money-totals-are-derived-not-written.test.ts` read their source text; nothing
 * ran either one. This drives both against an in-memory store and a synthetic
 * `wallet_transfer` RPC, through the real `transferWallets` wrapper, the real
 * split allocation and the real error wording, and asserts what each one
 * writes, sends and answers.
 *
 * Finding: MAIN-F-F07 (money server actions with no test). Register B:
 * ACTION-148C47BB8A22 (addFundsAction), ACTION-8F2CA578152D (sendMoneyAction).
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

const { addFundsAction, sendMoneyAction } = await import('@/app/(app)/wallet/actions');
const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
const { describeActionError } = await import('@/lib/supabase/errors');
const { householdPolicyBlocked } = await import('@/lib/trust/messages');
const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);

const DENY = { effect: 'deny', reason: 'Blocked by policy: Finances.', reasonKey: 'trust.denyBlockedByPolicy', reasonParams: { domain: 'finances' }, basis: 'policy' } as const;
const BUCKETS = ['spend', 'save', 'give', 'invest'] as const;

let db: InMemorySupabase;
let rpcCalls: Record<string, unknown>[];

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  rpcCalls = [];
  db = createInMemorySupabase({
    rpc: { wallet_transfer: (args) => { rpcCalls.push(args); return harness.rpc?.(args); } },
  });
  harness.db = db;
  harness.role = 'parent';
  harness.rpc = () => ({ ok: true, debit_transaction_id: 'txn-debit', credit_transaction_id: 'txn-credit' });
  harness.decision = { effect: 'allow', reason: 'Allowed.' };
  harness.revalidatePath.mockClear();
  harness.evaluateTrust.mockClear();
  db.seed('child_wallets', [
    { id: 'wallet-a', family_id: FAMILY, member_id: 'member-a' },
    { id: 'wallet-b', family_id: FAMILY, member_id: 'member-b' },
    { id: 'wallet-x', family_id: 'family-2', member_id: 'member-x' },
  ]);
  db.seed('wallet_buckets', [
    ...BUCKETS.map((kind) => ({ id: `a-${kind}`, family_id: FAMILY, child_wallet_id: 'wallet-a', kind })),
    ...BUCKETS.map((kind) => ({ id: `x-${kind}`, family_id: 'family-2', child_wallet_id: 'wallet-x', kind })),
  ]);
});

/** Replace one table's builder method so its call answers `reply` (reads) or `error` (writes). */
function override(table: string, method: 'insert' | 'maybeSingle' | 'then', reply: Record<string, unknown>) {
  const from = db.from.bind(db);
  (db as unknown as { from: (name: string) => unknown }).from = (name: string) => {
    const builder = from(name) as unknown as Record<string, unknown>;
    if (name !== table) return builder;
    const answer = { data: null, count: null, status: 500, statusText: 'Error', ...reply };
    if (method === 'insert') builder.insert = () => ({ then: (resolve: (v: unknown) => unknown) => Promise.resolve(answer).then(resolve) });
    if (method === 'maybeSingle') builder.maybeSingle = async () => answer;
    if (method === 'then') builder.then = (resolve: (v: unknown) => unknown) => Promise.resolve(answer).then(resolve);
    return builder;
  };
}

const credits = () => db.table('wallet_transactions');
const audit = () => db.table('wallet_audit_logs');
const byBucket = (rows: Row[]) => Object.fromEntries(rows.map((r) => [r.bucket_id, r.amount_cents]));
const PG_ERROR = { code: '57014', message: 'canceling statement due to statement timeout', details: null, hint: null };

describe('addFundsAction (ACTION-148C47BB8A22)', () => {
  it('credits the child’s buckets by the default split, one completed row each, every cent accounted for', async () => {
    expect(await addFundsAction({ childWalletId: 'wallet-a', amountCents: 1_000 })).toEqual({ ok: true });

    expect(byBucket(credits())).toEqual({ 'a-spend': 400, 'a-save': 400, 'a-give': 100, 'a-invest': 100 });
    for (const row of credits()) {
      expect(row).toMatchObject({
        family_id: FAMILY, child_wallet_id: 'wallet-a', type: 'parent_top_up', status: 'completed', direction: 'credit',
        description: null, created_by: 'user-parent', approved_by: 'user-parent',
      });
    }
    expect(audit()).toHaveLength(1);
    expect(audit()[0]).toMatchObject({ family_id: FAMILY, actor_user_id: 'user-parent', action: 'funds_added', entity_id: 'wallet-a' });
    expect(harness.revalidatePath).toHaveBeenCalledWith('/wallet');
  });

  it('follows the child’s own split rule, and conserves an odd cent', async () => {
    db.seed('wallet_rules', [{ family_id: FAMILY, child_wallet_id: 'wallet-a', split: { spend: 50, save: 50, give: 0, invest: 0 } }]);

    expect(await addFundsAction({ childWalletId: 'wallet-a', amountCents: 1_001 })).toEqual({ ok: true });

    const parts = byBucket(credits());
    expect(Object.keys(parts).sort()).toEqual(['a-save', 'a-spend']);
    expect(parts['a-spend'] + parts['a-save']).toBe(1_001);
  });

  it('keeps a trimmed description and sends whole cents only', async () => {
    db.seed('wallet_rules', [{ family_id: FAMILY, child_wallet_id: 'wallet-a', split: { spend: 100, save: 0, give: 0, invest: 0 } }]);

    expect(await addFundsAction({ childWalletId: 'wallet-a', amountCents: 2_500.9, description: '  Birthday  ' })).toEqual({ ok: true });

    expect(credits()).toHaveLength(1);
    expect(credits()[0]).toMatchObject({ bucket_id: 'a-spend', amount_cents: 2_500, description: 'Birthday' });
  });

  it.each(['teen', 'child', 'caregiver', 'guest'])('refuses a %s before reading or writing anything', async (role) => {
    harness.role = role;
    expect(await addFundsAction({ childWalletId: 'wallet-a', amountCents: 1_000 })).toEqual({ ok: false, error: t('actions.onlyAParentGuardianCan2') });
    expect(db.log).toHaveLength(0);
    expect(credits()).toHaveLength(0);
  });

  it.each([0, -1, -1_000, 0.5, Number.NaN, Number.POSITIVE_INFINITY])('refuses an amount of %s and credits nothing', async (amountCents) => {
    expect(await addFundsAction({ childWalletId: 'wallet-a', amountCents })).toEqual({ ok: false, error: t('actions.enterAnAmountGreaterThan') });
    expect(credits()).toHaveLength(0);
    expect(harness.revalidatePath).not.toHaveBeenCalled();
  });

  it('accepts the smallest amount, one cent, into exactly one bucket', async () => {
    expect(await addFundsAction({ childWalletId: 'wallet-a', amountCents: 1 })).toEqual({ ok: true });
    expect(credits()).toHaveLength(1);
    expect(credits()[0]).toMatchObject({ amount_cents: 1 });
  });

  it('does not credit another family’s wallet, and does not ask the policy about it', async () => {
    expect(await addFundsAction({ childWalletId: 'wallet-x', amountCents: 1_000 })).toEqual({ ok: false, error: t('actions.thatWalletWasNotFound') });
    expect(credits()).toHaveLength(0);
    expect(harness.evaluateTrust).not.toHaveBeenCalled();
  });

  it('does not credit a wallet that does not exist', async () => {
    expect(await addFundsAction({ childWalletId: 'wallet-missing', amountCents: 1_000 })).toEqual({ ok: false, error: t('actions.thatWalletWasNotFound') });
    expect(credits()).toHaveLength(0);
  });

  // Activation writes the wallet and its buckets in separate statements, so a
  // wallet can exist with no buckets. A top-up used to write its credits with
  // bucket_id NULL and answer ok: money in the ledger and in no balance.
  it('refuses a wallet whose buckets were never provisioned, and writes no bucketless credit', async () => {
    expect(await addFundsAction({ childWalletId: 'wallet-b', amountCents: 1_000 })).toEqual({ ok: false, error: t('actions.couldNotProvisionWalletBuckets') });
    expect(credits()).toHaveLength(0);
    expect(audit()).toHaveLength(0);
    expect(harness.revalidatePath).not.toHaveBeenCalled();
  });

  it('refuses a wallet missing only one bucket the split would credit', async () => {
    db.seed('wallet_buckets', BUCKETS.filter((k) => k !== 'give').map((kind) => ({ id: `b-${kind}`, family_id: FAMILY, child_wallet_id: 'wallet-b', kind })));
    expect(await addFundsAction({ childWalletId: 'wallet-b', amountCents: 1_000 })).toEqual({ ok: false, error: t('actions.couldNotProvisionWalletBuckets') });
    expect(credits().filter((r) => r.bucket_id == null)).toHaveLength(0);
    expect(credits()).toHaveLength(0);
  });

  it.each([
    ['child_wallets', 'maybeSingle', 'actions.couldNotLoadThatWallet'],
    ['wallet_rules', 'maybeSingle', 'actions.couldNotLoadTheWallet'],
    ['wallet_buckets', 'then', 'actions.couldNotLoadTheWallet2'],
  ] as const)('fails closed when %s cannot be read', async (table, method, key) => {
    override(table, method, { error: PG_ERROR });

    expect(await addFundsAction({ childWalletId: 'wallet-a', amountCents: 1_000 })).toEqual({ ok: false, error: describeActionError(PG_ERROR, t(key)) });
    expect(credits()).toHaveLength(0);
    expect(harness.evaluateTrust).not.toHaveBeenCalled();
  });

  it('asks the household policy as this member, for this amount, and a deny credits nothing', async () => {
    harness.decision = DENY;

    const result = await addFundsAction({ childWalletId: 'wallet-a', amountCents: 1_234 });

    expect(result).toEqual({ ok: false, error: householdPolicyBlocked(t, DENY) });
    const [, family, request] = harness.evaluateTrust.mock.calls[0] as [unknown, string, { title: string }];
    expect(family).toBe(FAMILY);
    expect(request).toMatchObject({
      actor: { kind: 'member', id: 'member-self', role: 'parent' }, domain: 'finances', capability: 'automate',
      context: { amountCents: 1_234 }, openApproval: false,
    });
    expect(request.title).toContain('12.34');
    expect(credits()).toHaveLength(0);
    expect(audit()).toHaveLength(0);
  });

  it('reports a refused ledger write as a failure, in words, with no audit row and no refresh', async () => {
    const error = { code: '42501', message: 'new row violates row-level security policy for table "wallet_transactions"', details: null, hint: null };
    override('wallet_transactions', 'insert', { error, status: 403 });

    const result = await addFundsAction({ childWalletId: 'wallet-a', amountCents: 1_000 });

    expect(result).toEqual({ ok: false, error: describeActionError(error, t('actions.couldNotAddThoseFunds')) });
    expect(result.error).not.toContain('row-level security');
    expect(audit()).toHaveLength(0);
    expect(harness.revalidatePath).not.toHaveBeenCalled();
  });

  it('keeps the credit when only the audit row fails to write, and logs that it was not recorded', async () => {
    override('wallet_audit_logs', 'insert', { error: PG_ERROR });

    expect(await addFundsAction({ childWalletId: 'wallet-a', amountCents: 1_000 })).toEqual({ ok: true });
    expect(credits()).toHaveLength(4);
    expect(console.error).toHaveBeenCalledWith('[wallet-audit] added funds was not recorded', PG_ERROR);
  });
});

describe('sendMoneyAction (ACTION-8F2CA578152D)', () => {
  const send = (over: Partial<{ fromChildWalletId: string; toChildWalletId: string; amountCents: number; note: string }> = {}) =>
    sendMoneyAction({ fromChildWalletId: 'wallet-a', toChildWalletId: 'wallet-b', amountCents: 500, ...over });

  it('moves money through the atomic RPC between two of the family’s wallets, as the parent', async () => {
    expect(await send({ note: 'For the movie' })).toEqual({ ok: true });

    expect(rpcCalls).toEqual([{
      p_family_id: FAMILY, p_from_child_wallet_id: 'wallet-a', p_to_child_wallet_id: 'wallet-b',
      p_amount: 500, p_note: 'For the movie', p_actor_id: 'user-parent',
    }]);
    expect(harness.revalidatePath).toHaveBeenCalledWith('/wallet');
    // The action writes no ledger rows itself; the RPC debits and credits.
    expect(credits()).toHaveLength(0);
  });

  it('sends no note as null, and whole cents only', async () => {
    expect(await send({ amountCents: 250.7 })).toEqual({ ok: true });
    expect(rpcCalls[0]).toMatchObject({ p_amount: 250, p_note: null });
  });

  it('asks the household policy as this member, for this amount', async () => {
    await send({ amountCents: 1_234 });
    const [client, family, request] = harness.evaluateTrust.mock.calls[0] as [unknown, string, { title: string }];
    expect(client).toBe(db);
    expect(family).toBe(FAMILY);
    expect(request).toMatchObject({
      actor: { kind: 'member', id: 'member-self', role: 'parent' }, domain: 'finances', capability: 'automate',
      context: { amountCents: 1_234 }, openApproval: false,
    });
    expect(request.title).toContain('12.34');
  });

  it.each(['teen', 'child', 'caregiver', 'guest'])('refuses a %s before reading or moving anything', async (role) => {
    harness.role = role;
    expect(await send()).toEqual({ ok: false, error: t('actions.onlyAParentGuardianCan18') });
    expect(db.log).toHaveLength(0);
    expect(rpcCalls).toHaveLength(0);
  });

  it.each([0, -1, -500, 0.5, Number.NaN, Number.POSITIVE_INFINITY])('refuses an amount of %s and moves nothing', async (amountCents) => {
    expect(await send({ amountCents })).toEqual({ ok: false, error: t('actions.enterAnAmountGreaterThan') });
    expect(rpcCalls).toHaveLength(0);
  });

  it('refuses sending a wallet money to itself, before any read', async () => {
    expect(await send({ toChildWalletId: 'wallet-a' })).toEqual({ ok: false, error: t('actions.pickTwoDifferentWallets') });
    expect(db.log).toHaveLength(0);
    expect(rpcCalls).toHaveLength(0);
  });

  it.each([
    ['to another family’s wallet', { toChildWalletId: 'wallet-x' }],
    ['from another family’s wallet', { fromChildWalletId: 'wallet-x' }],
    ['to a wallet that does not exist', { toChildWalletId: 'wallet-missing' }],
  ])('refuses sending %s, and does not ask the policy', async (_, over) => {
    expect(await send(over)).toEqual({ ok: false, error: t('actions.oneOfThoseWalletsWas') });
    expect(rpcCalls).toHaveLength(0);
    expect(harness.evaluateTrust).not.toHaveBeenCalled();
  });

  it('fails closed when the wallets cannot be read', async () => {
    override('child_wallets', 'then', { error: PG_ERROR });
    expect(await send()).toEqual({ ok: false, error: describeActionError(PG_ERROR, t('actions.couldNotLoadTheWallets')) });
    expect(rpcCalls).toHaveLength(0);
  });

  it('moves nothing when the household policy denies it', async () => {
    harness.decision = DENY;
    expect(await send()).toEqual({ ok: false, error: householdPolicyBlocked(t, DENY) });
    expect(rpcCalls).toHaveLength(0);
    expect(harness.revalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    [{ ok: false, reason: 'insufficient_funds', available: 120 }, 'Only 1.20 is available.'],
    [{ ok: false, reason: 'wallet_buckets_missing' }, 'The recipient wallet is not fully provisioned.'],
    [{ ok: false, reason: 'spend_bucket_missing' }, 'The wallet Spend bucket is unavailable.'],
    [{ ok: false, reason: 'forbidden' }, 'You are not allowed to manage this family wallet.'],
    [{ ok: false, reason: 'something_new' }, 'Could not transfer money between those wallets.'],
    [null, 'Could not transfer money between those wallets.'],
  ])('reports the RPC refusing (%j) as a failure, and does not claim success', async (answer, message) => {
    harness.rpc = () => answer;

    expect(await send()).toEqual({ ok: false, error: message });
    expect(rpcCalls).toHaveLength(1);
    expect(harness.revalidatePath).not.toHaveBeenCalled();
  });

  it('reports the RPC failing outright without passing on the database’s text', async () => {
    harness.rpc = () => { throw new Error('deadlock detected'); };

    const result = await send();

    expect(result.ok).toBe(false);
    expect(result.error).not.toContain('deadlock');
    expect(harness.revalidatePath).not.toHaveBeenCalled();
  });
});
