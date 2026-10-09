import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { decideInvestOrderAction, placeInvestOrderAction } from '@/app/(app)/wallet/invest/actions';

// MAIN-F-F07: execute the public actions with persisted, filtered in-memory
// rows. The decision RPC below is only a completion stub: these tests do not
// claim to exercise SQL locking, RLS, or cash/share settlement.
const mocks = vi.hoisted(() => ({
  createServer: vi.fn(),
  requireUserContext: vi.fn(),
  evaluateTrust: vi.fn(),
  revalidatePath: vi.fn(),
  householdPolicyBlocked: vi.fn(),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/trust/server', () => ({ evaluateTrust: mocks.evaluateTrust, roleOf: (role: string) => role }));
vi.mock('@/lib/trust/messages', () => ({ householdPolicyBlocked: mocks.householdPolicyBlocked }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));

const FAMILY = 'family-a';
const WALLET = 'wallet-a';
const ASSET = 'asset-a';
const BUCKET = 'bucket-a';
const ORDER = 'order-a';
const request = { childWalletId: WALLET, assetId: ASSET, side: 'buy' as const, shares: 2 };
const pendingOrder = {
  id: ORDER, family_id: FAMILY, child_wallet_id: WALLET, asset_id: ASSET,
  side: 'buy', shares: 2, price_cents: 500, amount_cents: 1000,
  status: 'pending', requested_by: 'user-child',
};
const databaseError = { code: 'XX000', message: 'private database detail', details: null, hint: null };
const failedReply = { data: null, error: databaseError, count: null, status: 500, statusText: 'Error' };
let db: InMemorySupabase;
const completeDecision = vi.fn<(args: Record<string, unknown>, client: InMemorySupabase) => unknown>();

function asRole(role: string) {
  mocks.requireUserContext.mockResolvedValue({
    user: { id: `user-${role}` },
    active: { familyId: FAMILY, role, member: { id: `member-${role}` } },
  });
}

// Inject a returned query error (or a transport rejection for settleAll) at
// the client boundary, keeping the real query builders for every other table.
function failTable(table: string, reject = false) {
  const from = db.from.bind(db);
  vi.spyOn(db, 'from').mockImplementation((name) => {
    const query = from(name);
    if (name === table) {
      if (reject) vi.spyOn(query, 'maybeSingle').mockRejectedValue(new Error(databaseError.message));
      else vi.spyOn(query, 'maybeSingle').mockResolvedValue(failedReply);
      vi.spyOn(query, 'then').mockImplementation((resolve, rejectQuery) => Promise.resolve(failedReply).then(resolve, rejectQuery));
    }
    return query;
  });
}

function cashAndShares() {
  return structuredClone({
    transactions: db.table('wallet_transactions'),
    holdings: db.table('invest_holdings'),
  });
}

async function expectRequestRefused(input: Parameters<typeof placeInvestOrderAction>[0], error: string) {
  const before = cashAndShares();
  expect(await placeInvestOrderAction(input)).toEqual({ ok: false, error });
  expect(db.table('invest_orders')).toEqual([]);
  expect(cashAndShares()).toEqual(before);
  expect(db.rpc).not.toHaveBeenCalled();
  expect(mocks.revalidatePath).not.toHaveBeenCalled();
}

async function expectDecisionRefused(error: string) {
  const before = structuredClone(db.table('invest_orders'));
  expect(await decideInvestOrderAction({ orderId: ORDER, approve: true })).toEqual({ ok: false, error });
  expect(db.table('invest_orders')).toEqual(before);
  expect(db.rpc).not.toHaveBeenCalled();
  expect(mocks.revalidatePath).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.resetAllMocks();
  asRole('child');
  mocks.evaluateTrust.mockResolvedValue({ decision: { effect: 'allow', basis: 'allow_grant' } });
  mocks.householdPolicyBlocked.mockReturnValue('household-policy-blocked');
  completeDecision.mockReturnValue({ ok: true });
  db = createInMemorySupabase({ rpc: { invest_decide_order: completeDecision } });
  vi.spyOn(db, 'rpc');
  mocks.createServer.mockResolvedValue(db);
  // The caller's own wallet: a child orders only on their own (a sibling's is
  // tests/a-child-invests-only-their-own-money.test.ts).
  db.seed('child_wallets', [{ id: WALLET, family_id: FAMILY, member_id: 'member-child' }]);
  db.seed('invest_assets', [{ id: ASSET, price_cents: 500, is_active: true }]);
  db.seed('wallet_buckets', [{ id: BUCKET, family_id: FAMILY, child_wallet_id: WALLET, kind: 'invest' }]);
  db.seed('wallet_transactions', [
    { id: 'credit', family_id: FAMILY, bucket_id: BUCKET, direction: 'credit', amount_cents: 1000, status: 'completed' },
    { id: 'processing', family_id: FAMILY, bucket_id: BUCKET, direction: 'credit', amount_cents: 500, status: 'processing' },
    { id: 'debit', family_id: FAMILY, bucket_id: BUCKET, direction: 'debit', amount_cents: 500, status: 'completed' },
  ]);
  db.seed('invest_holdings', [{ family_id: FAMILY, child_wallet_id: WALLET, asset_id: ASSET, shares: 2 }]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('placeInvestOrderAction', () => {
  it.each([0, -1, NaN, Infinity, 0.00001])('refuses invalid shares %s before creating a client', async (shares) => {
    await expectRequestRefused({ ...request, shares }, 'actions.enterANumberOfShares');
    expect(mocks.createServer).not.toHaveBeenCalled();
  });

  it.each([
    ['child_wallets', 'invest.couldNotLoadTheChildWallet'],
    ['invest_assets', 'invest.couldNotLoadTheInvestment'],
  ])('reports a failed %s read instead of treating it as a missing row', async (table, error) => {
    failTable(table);
    await expectRequestRefused(request, error);
    expect(mocks.evaluateTrust).not.toHaveBeenCalled();
  });

  it.each([
    ['child_wallets', 'invest.couldNotLoadTheChildWallet'],
    ['invest_assets', 'invest.couldNotLoadTheInvestment'],
  ])('settles a rejected %s read into a sanitized action failure', async (table, error) => {
    failTable(table, true);
    await expectRequestRefused(request, error);
  });

  it.each(['missing', 'another family'])('refuses a wallet from %s', async (kind) => {
    db.replace('child_wallets', kind === 'missing' ? [] : [{ id: WALLET, family_id: 'family-b' }]);
    await expectRequestRefused(request, 'actions.childWalletNotFound');
  });

  it.each(['missing', 'inactive'])('refuses an %s asset', async (kind) => {
    if (kind === 'missing') db.replace('invest_assets', []);
    else db.table('invest_assets')[0].is_active = false;
    await expectRequestRefused(request, 'actions.thatInvestmentIsNotAvailable');
    expect(mocks.evaluateTrust).not.toHaveBeenCalled();
  });

  it('refuses a positive share count whose price rounds to zero cents', async () => {
    await expectRequestRefused({ ...request, shares: 0.0001 }, 'actions.amountMustBeGreaterThan');
  });

  it.each(['wallet_buckets', 'wallet_transactions'])('reports a failed %s read instead of insufficient cash', async (table) => {
    failTable(table);
    await expectRequestRefused(request, 'invest.couldNotLoadTheInvestBalance');
    expect(mocks.evaluateTrust).not.toHaveBeenCalled();
  });

  it('refuses a buy when the Invest bucket is missing', async () => {
    db.replace('wallet_buckets', []);
    await expectRequestRefused(request, 'actions.notEnoughMoneyInThe');
  });

  it('refuses insufficient cash, excluding other families, buckets, and failed credits', async () => {
    db.seed('wallet_transactions', [
      { family_id: 'family-b', bucket_id: BUCKET, direction: 'credit', amount_cents: 10000, status: 'completed' },
      { family_id: FAMILY, bucket_id: 'bucket-b', direction: 'credit', amount_cents: 10000, status: 'completed' },
      { family_id: FAMILY, bucket_id: BUCKET, direction: 'credit', amount_cents: 10000, status: 'failed' },
    ]);
    await expectRequestRefused({ ...request, shares: 2.01 }, 'actions.notEnoughMoneyInThe');
    expect(mocks.evaluateTrust).not.toHaveBeenCalled();
  });

  it('reports a failed holding read instead of insufficient shares', async () => {
    failTable('invest_holdings');
    await expectRequestRefused({ ...request, side: 'sell' }, 'invest.couldNotLoadTheInvestmentHolding');
  });

  it.each(['missing', 'insufficient', 'another family', 'another wallet', 'another asset'])('refuses a sell with %s holdings', async (kind) => {
    const holding = db.table('invest_holdings')[0];
    if (kind === 'missing') db.replace('invest_holdings', []);
    if (kind === 'insufficient') holding.shares = 1.99;
    if (kind === 'another family') holding.family_id = 'family-b';
    if (kind === 'another wallet') holding.child_wallet_id = 'wallet-b';
    if (kind === 'another asset') holding.asset_id = 'asset-b';
    await expectRequestRefused({ ...request, side: 'sell' }, 'actions.notEnoughSharesToSell');
    expect(mocks.evaluateTrust).not.toHaveBeenCalled();
  });

  it.each(['deny_grant', 'policy'])('blocks an explicit trust denial from %s', async (basis) => {
    const decision = { effect: 'deny', basis };
    mocks.evaluateTrust.mockResolvedValue({ decision });
    await expectRequestRefused(request, 'household-policy-blocked');
    expect(mocks.householdPolicyBlocked).toHaveBeenCalledWith(expect.any(Function), decision);
  });

  it('reports a failed insert without a success invalidation', async () => {
    failTable('invest_orders');
    await expectRequestRefused(request, 'invest.couldNotPlaceTheInvestmentOrder');
  });

  it.each(['buy', 'sell'] as const)('persists a pending %s at the exact available balance/shares, even with a default trust denial', async (side) => {
    mocks.evaluateTrust.mockResolvedValue({ decision: { effect: 'deny', basis: 'role_default' } });
    const before = cashAndShares();
    expect(await placeInvestOrderAction({ ...request, side })).toEqual({ ok: true });
    const readback = await db.from('invest_orders').select('*').eq('family_id', FAMILY).single();
    expect(readback.error).toBeNull();
    expect(readback.data).toMatchObject({
      family_id: FAMILY, child_wallet_id: WALLET, asset_id: ASSET, side,
      shares: 2, price_cents: 500, amount_cents: 1000, status: 'pending', requested_by: 'user-child',
    });
    expect(db.table('invest_orders')).toHaveLength(1);
    expect(cashAndShares()).toEqual(before);
    expect(db.rpc).not.toHaveBeenCalled();
    expect(mocks.evaluateTrust).toHaveBeenCalledExactlyOnceWith(db, FAMILY, {
      actor: { kind: 'member', id: 'member-child', role: 'child' },
      domain: 'finances', capability: 'automate', title: `Invest order: ${side} 10.00`,
      context: { amountCents: 1000 }, openApproval: false,
    });
    expect(mocks.householdPolicyBlocked).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).toHaveBeenCalledExactlyOnceWith('/wallet/invest');
  });

  it('persists the normalized share count and amount rather than the unrounded input', async () => {
    expect(await placeInvestOrderAction({ ...request, shares: 1.23459 })).toEqual({ ok: true });
    const { data } = await db.from('invest_orders').select('shares, amount_cents').single();
    expect(data).toEqual({ shares: 1.2345, amount_cents: 617 });
  });
});

describe('decideInvestOrderAction', () => {
  beforeEach(() => {
    asRole('parent');
    db.seed('invest_orders', [pendingOrder]);
  });

  it.each(['child', 'teen', 'caregiver', 'guest'])('refuses a %s before creating a client', async (role) => {
    asRole(role);
    await expectDecisionRefused('actions.onlyAParentGuardianCan');
    expect(mocks.createServer).not.toHaveBeenCalled();
  });

  it('reports a failed order read instead of order not found', async () => {
    failTable('invest_orders');
    await expectDecisionRefused('invest.couldNotLoadTheInvestmentOrder');
    expect(mocks.evaluateTrust).not.toHaveBeenCalled();
  });

  it.each(['missing', 'another family'])('refuses an order from %s', async (kind) => {
    if (kind === 'missing') db.replace('invest_orders', []);
    else db.table('invest_orders')[0].family_id = 'family-b';
    await expectDecisionRefused('actions.orderNotFound');
  });

  it.each(['filled', 'rejected', 'cancelled'])('does not call the decision RPC for an already %s order', async (status) => {
    db.table('invest_orders')[0].status = status;
    await expectDecisionRefused('actions.thisOrderWasAlreadyDecided');
    expect(mocks.evaluateTrust).not.toHaveBeenCalled();
  });

  it.each(['deny_grant', 'policy', 'role_default'])('refuses approval for a %s trust denial', async (basis) => {
    const decision = { effect: 'deny', basis };
    mocks.evaluateTrust.mockResolvedValue({ decision });
    await expectDecisionRefused('household-policy-blocked');
    expect(mocks.householdPolicyBlocked).toHaveBeenCalledWith(expect.any(Function), decision);
  });

  it('reports an RPC error without exposing its database details or invalidating', async () => {
    completeDecision.mockImplementation(() => { throw new Error(databaseError.message); });
    expect(await decideInvestOrderAction({ orderId: ORDER, approve: true })).toEqual({
      ok: false, error: 'invest.couldNotDecideTheInvestmentOrder',
    });
    expect(db.rpc).toHaveBeenCalledExactlyOnceWith('invest_decide_order', { p_order_id: ORDER, p_approve: true });
    expect(db.table('invest_orders')[0].status).toBe('pending');
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    ['null', null], ['array', [{ ok: true }]], ['primitive', true],
    ['empty object', {}], ['string ok', { ok: 'true' }], ['numeric ok', { ok: 1 }],
    ['false ok', { ok: false }], ['unknown reason', { ok: false, reason: 'private database detail' }],
  ])('rejects a %s RPC response without invalidating', async (_label, response) => {
    completeDecision.mockReturnValue(response);
    expect(await decideInvestOrderAction({ orderId: ORDER, approve: true })).toEqual({
      ok: false, error: 'invest.couldNotDecideTheInvestment',
    });
    expect(db.rpc).toHaveBeenCalledTimes(1);
    expect(db.table('invest_orders')[0].status).toBe('pending');
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    ['unauthenticated', 'Please sign in to continue.'],
    ['forbidden', 'Only a parent or guardian can approve investing.'],
    ['not_found', 'actions.orderNotFound'],
    ['already_decided', 'actions.thisOrderWasAlreadyDecided'],
    ['missing_invest_bucket', 'The Invest bucket is not available for this child.'],
    ['insufficient_cash', 'No longer enough in the Invest bucket.'],
    ['insufficient_shares', 'No longer enough shares to sell.'],
  ])('returns the RPC refusal for %s, including races after the pending read', async (reason, error) => {
    completeDecision.mockReturnValue({ ok: false, reason });
    expect(await decideInvestOrderAction({ orderId: ORDER, approve: true })).toEqual({ ok: false, error });
    expect(db.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    ['parent', true, 'filled'], ['adult', true, 'filled'], ['parent', false, 'rejected'],
  ] as const)('lets a %s decide approve=%s and read back %s after RPC completion', async (role, approve, status) => {
    asRole(role);
    mocks.evaluateTrust.mockResolvedValue({ decision: { effect: approve ? 'allow' : 'deny', basis: 'policy' } });
    completeDecision.mockImplementation((args, client) => {
      // Script only the persisted acknowledgement of this RPC. Settlement
      // belongs to SQL and is deliberately not reimplemented by this fake.
      expect(mocks.revalidatePath).not.toHaveBeenCalled();
      const order = client.table('invest_orders').find((row) => row.id === args.p_order_id);
      expect(order?.status).toBe('pending');
      Object.assign(order!, { status });
      return { ok: true };
    });
    const before = cashAndShares();
    expect(await decideInvestOrderAction({ orderId: ORDER, approve })).toEqual({ ok: true });
    expect(db.rpc).toHaveBeenCalledExactlyOnceWith('invest_decide_order', { p_order_id: ORDER, p_approve: approve });
    const readback = await db.from('invest_orders').select('status').eq('id', ORDER).eq('family_id', FAMILY).single();
    expect(readback.error).toBeNull();
    expect(readback.data).toEqual({ status });
    expect(cashAndShares()).toEqual(before);
    if (approve) {
      expect(mocks.evaluateTrust).toHaveBeenCalledExactlyOnceWith(db, FAMILY, {
        actor: { kind: 'member', id: `member-${role}`, role },
        domain: 'finances', capability: 'approve', title: 'Fill invest order 10.00',
        context: { amountCents: 1000 }, openApproval: false,
      });
    } else {
      expect(mocks.evaluateTrust).not.toHaveBeenCalled();
    }
    expect(mocks.revalidatePath).toHaveBeenCalledExactlyOnceWith('/wallet/invest');
  });
});
