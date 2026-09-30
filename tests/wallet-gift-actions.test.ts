import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

/**
 * createGiftLinkAction and approveGiftAction (app/(app)/wallet/actions.ts), run
 * as code. `wallet-atomic-persistence.test.ts` and
 * `a-money-decision-row-is-parent-written.test.ts` read their source and the
 * migrations; `a-decided-gift-stays-decided.test.ts` runs dismissGiftAction
 * only. Nothing ran these two. This drives both against an in-memory store and
 * a synthetic `wallet_approve_gift` RPC, through the real `approveGift` wrapper
 * and the real error wording.
 *
 * The synthetic RPC records its arguments and answers what a test tells it to.
 * It does not lock rows or move money: `wallet_approve_gift` (0205) does that
 * in the database, and nothing here stands in for it.
 *
 * Finding: MAIN-F-F07. Register B: ACTION-4EFA99FD3EF9 (createGiftLinkAction),
 * ACTION-0F463285844F (approveGiftAction).
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

const { createGiftLinkAction, approveGiftAction } = await import('@/app/(app)/wallet/actions');
const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
const { describeActionError } = await import('@/lib/supabase/errors');
const { householdPolicyBlocked } = await import('@/lib/trust/messages');
const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);

const DENY = { effect: 'deny', reason: 'Blocked by policy: Finances.', reasonKey: 'trust.denyBlockedByPolicy', reasonParams: { domain: 'finances' }, basis: 'policy' } as const;
const PG_ERROR = { code: '57014', message: 'canceling statement due to statement timeout', details: null, hint: null };
const NON_MANAGERS = ['teen', 'child', 'caregiver', 'guest'];

let db: InMemorySupabase;
let rpcCalls: Record<string, unknown>[];

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  rpcCalls = [];
  db = createInMemorySupabase({
    rpc: { wallet_approve_gift: (args) => { rpcCalls.push(args); return harness.rpc?.(args); } },
  });
  harness.db = db;
  harness.role = 'parent';
  harness.rpc = () => ({ ok: true, transaction_id: 'txn-gift' });
  harness.decision = { effect: 'allow', reason: 'Allowed.' };
  harness.revalidatePath.mockClear();
  harness.evaluateTrust.mockClear();
  db.seed('child_wallets', [
    { id: 'wallet-a', family_id: FAMILY, member_id: 'member-a' },
    { id: 'wallet-x', family_id: 'family-2', member_id: 'member-x' },
  ]);
  db.seed('gift_payments', [
    { id: 'gift-pending', family_id: FAMILY, child_wallet_id: 'wallet-a', amount_cents: 2_500, status: 'pending', giver_name: 'Grandma', applied_txn_id: null },
    { id: 'gift-completed', family_id: FAMILY, child_wallet_id: 'wallet-a', amount_cents: 1_000, status: 'completed', giver_name: 'Uncle', applied_txn_id: 'txn-old' },
    { id: 'gift-applied', family_id: FAMILY, child_wallet_id: 'wallet-a', amount_cents: 1_000, status: 'pending', giver_name: 'Aunt', applied_txn_id: 'txn-old-2' },
    { id: 'gift-no-wallet', family_id: FAMILY, child_wallet_id: null, amount_cents: 1_000, status: 'pending', giver_name: 'Friend', applied_txn_id: null },
    { id: 'gift-declined', family_id: FAMILY, child_wallet_id: 'wallet-a', amount_cents: 1_000, status: 'cancelled', giver_name: 'Neighbour', applied_txn_id: null },
    { id: 'gift-elsewhere', family_id: 'family-2', child_wallet_id: 'wallet-x', amount_cents: 9_000, status: 'pending', giver_name: 'Stranger', applied_txn_id: null },
  ]);
});

/** Replace one table's builder method so that call answers `reply`. */
function override(table: string, method: 'insert' | 'maybeSingle', reply: Record<string, unknown>) {
  const from = db.from.bind(db);
  (db as unknown as { from: (name: string) => unknown }).from = (name: string) => {
    const builder = from(name) as unknown as Record<string, unknown>;
    if (name !== table) return builder;
    const answer = { data: null, count: null, status: 500, statusText: 'Error', ...reply };
    if (method === 'insert') builder.insert = () => ({ then: (resolve: (v: unknown) => unknown) => Promise.resolve(answer).then(resolve) });
    if (method === 'maybeSingle') builder.maybeSingle = async () => answer;
    return builder;
  };
}

const links = () => db.table('gift_links');

describe('createGiftLinkAction (ACTION-4EFA99FD3EF9)', () => {
  it('creates a link for the family’s child wallet and hands back its token', async () => {
    const result = await createGiftLinkAction({ childWalletId: 'wallet-a', occasion: 'Birthday', message: 'Happy 9th!', suggestedCents: [500, 1_000, 2_500] });

    expect(result.ok).toBe(true);
    expect(result.token).toMatch(/^gift_[0-9a-f]{32}$/);
    expect(links()).toHaveLength(1);
    expect(links()[0]).toMatchObject({
      family_id: FAMILY, child_wallet_id: 'wallet-a', token: result.token, occasion: 'Birthday', message: 'Happy 9th!',
      suggested_cents: [500, 1_000, 2_500], created_by: 'user-parent',
    });
    expect(harness.revalidatePath).toHaveBeenCalledWith('/wallet/gift');
  });

  it('stores no occasion or message as null, and leaves no suggested amounts to the column default', async () => {
    const result = await createGiftLinkAction({ childWalletId: 'wallet-a', suggestedCents: [] });

    expect(result.ok).toBe(true);
    expect(links()[0]).toMatchObject({ occasion: null, message: null });
    expect(links()[0].suggested_cents).toBeUndefined();
  });

  it('gives every link its own token', async () => {
    const first = await createGiftLinkAction({ childWalletId: 'wallet-a' });
    const second = await createGiftLinkAction({ childWalletId: 'wallet-a' });
    expect(first.token).not.toBe(second.token);
    expect(links().map((l) => l.token)).toEqual([first.token, second.token]);
  });

  it('lets an adult manager create one too', async () => {
    harness.role = 'adult';
    expect((await createGiftLinkAction({ childWalletId: 'wallet-a' })).ok).toBe(true);
  });

  it.each(NON_MANAGERS)('refuses a %s before reading or writing anything', async (role) => {
    harness.role = role;
    expect(await createGiftLinkAction({ childWalletId: 'wallet-a' })).toEqual({ ok: false, error: t('actions.onlyAParentGuardianCan9') });
    expect(db.log).toHaveLength(0);
    expect(links()).toHaveLength(0);
    expect(harness.revalidatePath).not.toHaveBeenCalled();
  });

  it('does not create a link for another family’s wallet', async () => {
    expect(await createGiftLinkAction({ childWalletId: 'wallet-x' })).toEqual({ ok: false, error: t('actions.thatWalletWasNotFound') });
    expect(links()).toHaveLength(0);
    expect(harness.revalidatePath).not.toHaveBeenCalled();
  });

  it('does not create a link for a wallet that does not exist', async () => {
    expect(await createGiftLinkAction({ childWalletId: 'wallet-missing' })).toEqual({ ok: false, error: t('actions.thatWalletWasNotFound') });
    expect(links()).toHaveLength(0);
  });

  it('fails closed when the wallet cannot be read', async () => {
    override('child_wallets', 'maybeSingle', { error: PG_ERROR });
    expect(await createGiftLinkAction({ childWalletId: 'wallet-a' })).toEqual({ ok: false, error: describeActionError(PG_ERROR, t('actions.couldNotLoadThatWallet')) });
    expect(links()).toHaveLength(0);
  });

  it('reports a refused insert as a failure, in words, with no token and no refresh', async () => {
    const error = { code: '42501', message: 'new row violates row-level security policy for table "gift_links"', details: null, hint: null };
    override('gift_links', 'insert', { error, status: 403 });

    const result = await createGiftLinkAction({ childWalletId: 'wallet-a' });

    expect(result).toEqual({ ok: false, error: describeActionError(error, t('actions.couldNotCreateThatGift')) });
    expect(result.error).not.toContain('row-level security');
    expect(harness.revalidatePath).not.toHaveBeenCalled();
  });
});

describe('approveGiftAction (ACTION-0F463285844F)', () => {
  const approve = (giftPaymentId = 'gift-pending') => approveGiftAction({ giftPaymentId });

  it('approves the family’s pending gift through the RPC, once, as the parent', async () => {
    expect(await approve()).toEqual({ ok: true });

    expect(rpcCalls).toEqual([{ p_family_id: FAMILY, p_gift_payment_id: 'gift-pending', p_actor_id: 'user-parent' }]);
    expect(harness.revalidatePath).toHaveBeenCalledTimes(1);
    expect(harness.revalidatePath).toHaveBeenCalledWith('/wallet/gift');
    // The action writes neither the ledger nor the gift; the RPC does both.
    expect(db.table('wallet_transactions')).toHaveLength(0);
    expect(db.table('gift_payments').find((g) => g.id === 'gift-pending')).toMatchObject({ status: 'pending', applied_txn_id: null });
  });

  it('asks the household policy to approve, as this member, for the gift’s amount', async () => {
    await approve();

    expect(harness.evaluateTrust).toHaveBeenCalledTimes(1);
    const [client, family, request] = harness.evaluateTrust.mock.calls[0] as [unknown, string, { title: string }];
    expect(client).toBe(db);
    expect(family).toBe(FAMILY);
    expect(request).toMatchObject({
      actor: { kind: 'member', id: 'member-self', role: 'parent' }, domain: 'finances', capability: 'approve',
      context: { amountCents: 2_500 }, openApproval: false,
    });
    expect(request.title).toContain('25.00');
  });

  it.each(NON_MANAGERS)('refuses a %s before reading or crediting anything', async (role) => {
    harness.role = role;
    expect(await approve()).toEqual({ ok: false, error: t('actions.onlyAParentGuardianCan10') });
    expect(db.log).toHaveLength(0);
    expect(harness.evaluateTrust).not.toHaveBeenCalled();
    expect(rpcCalls).toHaveLength(0);
  });

  it.each([
    ['another family’s gift', 'gift-elsewhere'],
    ['a gift that does not exist', 'gift-missing'],
  ])('does not approve %s, and does not ask the policy', async (_, giftId) => {
    expect(await approve(giftId)).toEqual({ ok: false, error: t('actions.giftNotFound') });
    expect(rpcCalls).toHaveLength(0);
    expect(harness.evaluateTrust).not.toHaveBeenCalled();
    expect(harness.revalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    ['completed', 'gift-completed'],
    ['still pending but already credited', 'gift-applied'],
  ])('refuses a gift that is %s, before the policy or the RPC', async (_, giftId) => {
    expect(await approve(giftId)).toEqual({ ok: false, error: t('actions.thisGiftWasAlreadyApplied') });
    expect(rpcCalls).toHaveLength(0);
    expect(harness.evaluateTrust).not.toHaveBeenCalled();
  });

  it('refuses a gift with no child wallet', async () => {
    expect(await approve('gift-no-wallet')).toEqual({ ok: false, error: t('actions.thisGiftHasNoChild') });
    expect(rpcCalls).toHaveLength(0);
  });

  it('leaves a declined gift to the RPC, which refuses it, and reports that refusal', async () => {
    // The action short-circuits only gifts already applied; any other status is
    // the RPC's to judge under its row lock (0205: `status <> 'pending'`).
    harness.rpc = () => ({ ok: false, reason: 'already_processed' });

    expect(await approve('gift-declined')).toEqual({ ok: false, error: 'This wallet request was already processed.' });
    expect(rpcCalls).toHaveLength(1);
    expect(harness.revalidatePath).not.toHaveBeenCalled();
  });

  it('fails closed when the gift cannot be read', async () => {
    override('gift_payments', 'maybeSingle', { error: PG_ERROR });
    expect(await approve()).toEqual({ ok: false, error: describeActionError(PG_ERROR, t('actions.couldNotLoadThatGift')) });
    expect(rpcCalls).toHaveLength(0);
    expect(harness.evaluateTrust).not.toHaveBeenCalled();
  });

  it('credits nothing when the household policy denies it, and says why', async () => {
    harness.decision = DENY;
    expect(await approve()).toEqual({ ok: false, error: householdPolicyBlocked(t, DENY) });
    expect(rpcCalls).toHaveLength(0);
    expect(harness.revalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    [{ ok: false, reason: 'already_processed' }, 'This wallet request was already processed.'],
    [{ ok: false, reason: 'not_found' }, 'The wallet request was not found.'],
    [{ ok: false, reason: 'forbidden' }, 'You are not allowed to manage this family wallet.'],
    [{ ok: false, reason: 'wallet_buckets_missing' }, 'The recipient wallet is not fully provisioned.'],
    [{ ok: false, reason: 'invalid_gift' }, 'Could not approve that gift.'],
    [{ ok: false, reason: 'credit_failed' }, 'Could not approve that gift.'],
    [null, 'Could not approve that gift.'],
  ])('reports the RPC refusing (%j) as a failure, and does not refresh', async (answer, message) => {
    harness.rpc = () => answer;

    expect(await approve()).toEqual({ ok: false, error: message });
    expect(rpcCalls).toHaveLength(1);
    expect(harness.revalidatePath).not.toHaveBeenCalled();
  });

  it('reports the RPC failing outright without passing on the database’s text', async () => {
    harness.rpc = () => { throw new Error('deadlock detected'); };

    const result = await approve();

    expect(result.ok).toBe(false);
    expect(result.error).not.toContain('deadlock');
    expect(harness.revalidatePath).not.toHaveBeenCalled();
  });
});
