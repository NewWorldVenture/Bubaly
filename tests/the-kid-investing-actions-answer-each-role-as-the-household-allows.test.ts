// The two kid-investing actions, called with valid input by every role of
// household A, and with household B's ids.
//
// THE POLICY, from the sources rather than from the actions:
//   - lib/constants/roles.ts: isManager = parent or adult.
//   - app/(app)/wallet/invest/page.tsx: a card offers Buy/Sell when
//     `manager || cw.member_id === ctx.active.member.id`, and the approval queue
//     is handed `canManage={manager}`.
//   - lib/auth/guest-scope.ts: /wallet is withheld from a guest.
//   - lib/constants/feature-catalog.ts: 'family-wallet' is free, no plan gate.
//   - Live RLS for invest_orders inserts (0483, invest_orders_own_wallet_or_manager):
//     can_manage_family(family_id) or is_own_child_wallet(child_wallet_id).
//   - invest_decide_order (0447, the last definition): refuses unless
//     can_manage_family(order.family_id). The RPC handler below models that
//     check and the fill it performs, so a test reads the ledger back.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({
  db: null as unknown,
  ctx: null as null | { user: { id: string; email: string }; active: { familyId: string; role: string; member: { id: string } } },
  revalidated: [] as string[],
  rpcCalls: [] as unknown[],
  trust: [] as unknown[],
}));

vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => {
    if (!h.ctx) throw new Error('NEXT_REDIRECT:/login');
    return h.ctx;
  },
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/trust/server', () => ({
  evaluateTrust: async (_db: unknown, _family: string, request: unknown) => {
    h.trust.push(request);
    return { decision: { effect: 'allow', basis: 'role_default' } };
  },
  roleOf: (role: string) => role,
}));
vi.mock('@/lib/trust/messages', () => ({ householdPolicyBlocked: () => 'household-policy-blocked' }));
vi.mock('next/cache', () => ({ revalidatePath: (path: string) => { h.revalidated.push(path); } }));

const { placeInvestOrderAction, decideInvestOrderAction } = await import('@/app/(app)/wallet/invest/actions');

const FAMILY_A = 'family-a';
const FAMILY_B = 'family-b';
const ASSET = 'asset-index';

// Household A: Mia (child), Leo (child), Tess (teen), and a guest who was given
// a wallet before activation. Household B: Bo (child).
const MIA = { member: 'member-a-child', wallet: 'wallet-a-mia', bucket: 'bucket-a-mia' };
const LEO = { member: 'member-a-leo', wallet: 'wallet-a-leo', bucket: 'bucket-a-leo' };
const TESS = { member: 'member-a-teen', wallet: 'wallet-a-tess', bucket: 'bucket-a-tess' };
const GUEST = { member: 'member-a-guest', wallet: 'wallet-a-guest', bucket: 'bucket-a-guest' };
const BO = { member: 'member-b-child', wallet: 'wallet-b-bo', bucket: 'bucket-b-bo' };

const ORDER_A = 'order-a-mia-buy';
const ORDER_B = 'order-b-bo-buy';

type Role = 'parent' | 'adult' | 'teen' | 'child' | 'caregiver' | 'guest';

function signInAs(role: Role, opts: { family?: string; kidLogin?: boolean } = {}) {
  const family = opts.family ?? FAMILY_A;
  const tag = family === FAMILY_A ? 'a' : 'b';
  h.ctx = {
    user: { id: `user-${tag}-${role}`, email: opts.kidLogin ? `${tag}-${role}@kids.bubaly.app` : `${tag}-${role}@example.com` },
    active: { familyId: family, role, member: { id: `member-${tag}-${role}` } },
  };
}

let db: InMemorySupabase;

/** can_manage_family(family) for the signed-in caller, as the SQL helper answers it. */
const callerManages = (family: unknown) =>
  h.ctx !== null && h.ctx.active.familyId === family && ['parent', 'adult'].includes(h.ctx.active.role);

/** 0447's invest_decide_order, over the in-memory tables. */
function investDecideOrder(args: Record<string, unknown>, store: InMemorySupabase) {
  h.rpcCalls.push(args);
  const order = store.table('invest_orders').find((o) => o.id === args.p_order_id);
  if (!order) return { ok: false, reason: 'not_found' };
  if (!callerManages(order.family_id)) return { ok: false, reason: 'forbidden' };
  if (order.status !== 'pending') return { ok: false, reason: 'already_decided' };
  if (!args.p_approve) {
    Object.assign(order, { status: 'rejected', decided_by: h.ctx?.user.id });
    return { ok: true, status: 'rejected' };
  }
  const bucket = store.table('wallet_buckets').find((b) => b.family_id === order.family_id && b.child_wallet_id === order.child_wallet_id && b.kind === 'invest');
  if (!bucket) return { ok: false, reason: 'missing_invest_bucket' };
  const balance = store.table('wallet_transactions').filter((t) => t.bucket_id === bucket.id && t.status === 'completed')
    .reduce((s, t) => s + (t.direction === 'credit' ? Number(t.amount_cents) : -Number(t.amount_cents)), 0);
  const holding = store.table('invest_holdings').find((x) => x.child_wallet_id === order.child_wallet_id && x.asset_id === order.asset_id);
  if (order.side === 'buy' && Number(order.amount_cents) > balance) return { ok: false, reason: 'insufficient_cash' };
  store.seed('wallet_transactions', [{
    id: `txn-${order.id}`, family_id: order.family_id, child_wallet_id: order.child_wallet_id, bucket_id: bucket.id,
    direction: order.side === 'buy' ? 'debit' : 'credit', amount_cents: order.amount_cents, status: 'completed',
    related_type: 'invest_orders', related_id: order.id,
  }]);
  if (holding) holding.shares = Number(holding.shares) + (order.side === 'buy' ? 1 : -1) * Number(order.shares);
  Object.assign(order, { status: 'filled', txn_id: `txn-${order.id}`, decided_by: h.ctx?.user.id });
  return { ok: true, status: 'filled' };
}

/** Every table either action writes, in both households. */
const everything = () => structuredClone({
  orders: db.table('invest_orders'),
  transactions: db.table('wallet_transactions'),
  holdings: db.table('invest_holdings'),
});

beforeEach(() => {
  db = createInMemorySupabase({ rpc: { invest_decide_order: investDecideOrder } });
  h.db = db; h.ctx = null; h.revalidated = []; h.rpcCalls = []; h.trust = [];
  db.seed('child_wallets', [MIA, LEO, TESS, GUEST].map((w) => ({ id: w.wallet, family_id: FAMILY_A, member_id: w.member, is_active: true }))
    .concat([{ id: BO.wallet, family_id: FAMILY_B, member_id: BO.member, is_active: true }]));
  db.seed('invest_assets', [{ id: ASSET, price_cents: 500, is_active: true }]);
  db.seed('wallet_buckets', [MIA, LEO, TESS, GUEST].map((w) => ({ id: w.bucket, family_id: FAMILY_A, child_wallet_id: w.wallet, kind: 'invest' }))
    .concat([{ id: BO.bucket, family_id: FAMILY_B, child_wallet_id: BO.wallet, kind: 'invest' }]));
  db.seed('wallet_transactions', [MIA, LEO, TESS, GUEST].map((w) => ({ id: `cash-${w.wallet}`, family_id: FAMILY_A, bucket_id: w.bucket, direction: 'credit', amount_cents: 2000, status: 'completed' }))
    .concat([{ id: `cash-${BO.wallet}`, family_id: FAMILY_B, bucket_id: BO.bucket, direction: 'credit', amount_cents: 2000, status: 'completed' }]));
  db.seed('invest_holdings', [MIA, LEO, TESS, GUEST].map((w) => ({ id: `hold-${w.wallet}`, family_id: FAMILY_A, child_wallet_id: w.wallet, asset_id: ASSET, shares: 2 }))
    .concat([{ id: `hold-${BO.wallet}`, family_id: FAMILY_B, child_wallet_id: BO.wallet, asset_id: ASSET, shares: 2 }]));
  db.seed('invest_orders', [
    { id: ORDER_A, family_id: FAMILY_A, child_wallet_id: MIA.wallet, asset_id: ASSET, side: 'buy', shares: 2, price_cents: 500, amount_cents: 1000, status: 'pending', requested_by: 'user-a-child' },
    { id: ORDER_B, family_id: FAMILY_B, child_wallet_id: BO.wallet, asset_id: ASSET, side: 'buy', shares: 2, price_cents: 500, amount_cents: 1000, status: 'pending', requested_by: 'user-b-child' },
  ]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const place = (wallet: string, side: 'buy' | 'sell' = 'buy') =>
  placeInvestOrderAction({ childWalletId: wallet, assetId: ASSET, side, shares: 1 });

/** The one order a call added, read back from the table. */
const newOrders = () => db.table('invest_orders').filter((o) => o.id !== ORDER_A && o.id !== ORDER_B);

describe('placeInvestOrderAction', () => {
  it.each(['parent', 'adult'] as const)('ACTION-068676844C8C a %s of A queues a pending buy on a child\'s wallet', async (role) => {
    signInAs(role);
    expect(await place(MIA.wallet)).toEqual({ ok: true });
    expect(newOrders()).toEqual([expect.objectContaining({
      family_id: FAMILY_A, child_wallet_id: MIA.wallet, asset_id: ASSET, side: 'buy', shares: 1,
      price_cents: 500, amount_cents: 500, status: 'pending', requested_by: `user-a-${role}`,
    })]);
    expect(db.table('wallet_transactions')).toHaveLength(5);
    expect(h.revalidated).toEqual(['/wallet/invest']);
  });

  it('ACTION-068676844C8C a child of A queues a sell on their own wallet', async () => {
    signInAs('child');
    expect(await place(MIA.wallet, 'sell')).toEqual({ ok: true });
    expect(newOrders()).toEqual([expect.objectContaining({ child_wallet_id: MIA.wallet, side: 'sell', status: 'pending', requested_by: 'user-a-child' })]);
  });

  it('ACTION-068676844C8C a child on a kid login queues a buy on their own wallet', async () => {
    signInAs('child', { kidLogin: true });
    expect(await place(MIA.wallet)).toEqual({ ok: true });
    expect(newOrders()).toEqual([expect.objectContaining({ child_wallet_id: MIA.wallet, side: 'buy', status: 'pending' })]);
  });

  it('ACTION-068676844C8C a teen of A queues a buy on their own wallet', async () => {
    signInAs('teen');
    expect(await place(TESS.wallet)).toEqual({ ok: true });
    expect(newOrders()).toEqual([expect.objectContaining({ child_wallet_id: TESS.wallet, requested_by: 'user-a-teen' })]);
  });

  it.each([
    ['child', LEO.wallet],
    ['teen', MIA.wallet],
    ['caregiver', MIA.wallet],
  ] as const)('ACTION-068676844C8C a %s of A is refused on a wallet that is not theirs, and nothing is queued', async (role, wallet) => {
    signInAs(role);
    const before = everything();
    expect(await place(wallet, 'sell')).toEqual({ ok: false, error: 'actions.childWalletNotFound' });
    expect(everything()).toEqual(before);
    expect(h.trust).toEqual([]);
    expect(h.revalidated).toEqual([]);
  });

  it('ACTION-068676844C8C a guest of A is refused even on a wallet in their own name', async () => {
    signInAs('guest');
    const before = everything();
    expect(await place(GUEST.wallet)).toEqual({ ok: false, error: 'actions.childWalletNotFound' });
    expect(everything()).toEqual(before);
    expect(h.revalidated).toEqual([]);
  });

  it('ACTION-068676844C8C a signed-out caller queues nothing', async () => {
    const before = everything();
    await expect(place(MIA.wallet)).rejects.toThrow('NEXT_REDIRECT:/login');
    expect(everything()).toEqual(before);
  });

  it.each(['parent', 'adult', 'child'] as const)('ACTION-068676844C8C a %s of A is refused on household B\'s wallet, and neither household changes', async (role) => {
    signInAs(role);
    const before = everything();
    expect(await place(BO.wallet)).toEqual({ ok: false, error: 'actions.childWalletNotFound' });
    expect(everything()).toEqual(before);
    expect(h.trust).toEqual([]);
  });
});

describe('decideInvestOrderAction', () => {
  it.each(['parent', 'adult'] as const)('ACTION-142B5EB6AC00 a %s of A approves a child\'s buy, and it is filled against that child\'s Invest bucket', async (role) => {
    signInAs(role);
    expect(await decideInvestOrderAction({ orderId: ORDER_A, approve: true })).toEqual({ ok: true });
    expect(db.table('invest_orders').find((o) => o.id === ORDER_A)).toEqual(expect.objectContaining({ status: 'filled', decided_by: `user-a-${role}` }));
    expect(db.table('wallet_transactions').filter((t) => t.related_id === ORDER_A)).toEqual([
      expect.objectContaining({ bucket_id: MIA.bucket, direction: 'debit', amount_cents: 1000 }),
    ]);
    expect(db.table('invest_holdings').find((x) => x.child_wallet_id === MIA.wallet)?.shares).toBe(4);
    expect(db.table('invest_orders').find((o) => o.id === ORDER_B)?.status).toBe('pending');
    expect(h.revalidated).toEqual(['/wallet/invest']);
  });

  it.each(['parent', 'adult'] as const)('ACTION-142B5EB6AC00 a %s of A rejects a child\'s buy, and no money moves', async (role) => {
    signInAs(role);
    const transactions = structuredClone(db.table('wallet_transactions'));
    expect(await decideInvestOrderAction({ orderId: ORDER_A, approve: false })).toEqual({ ok: true });
    expect(db.table('invest_orders').find((o) => o.id === ORDER_A)?.status).toBe('rejected');
    expect(db.table('wallet_transactions')).toEqual(transactions);
  });

  it.each([
    ['teen', {}],
    ['child', {}],
    ['child', { kidLogin: true }],
    ['caregiver', {}],
    ['guest', {}],
  ] as const)('ACTION-142B5EB6AC00 a %s of A %o is refused before the order is read or the decision is asked for', async (role, opts) => {
    signInAs(role, opts);
    const before = everything();
    expect(await decideInvestOrderAction({ orderId: ORDER_A, approve: true })).toEqual({ ok: false, error: 'actions.onlyAParentGuardianCan' });
    expect(everything()).toEqual(before);
    expect(h.rpcCalls).toEqual([]);
    expect(h.revalidated).toEqual([]);
  });

  it('ACTION-142B5EB6AC00 a signed-out caller decides nothing', async () => {
    const before = everything();
    await expect(decideInvestOrderAction({ orderId: ORDER_A, approve: true })).rejects.toThrow('NEXT_REDIRECT:/login');
    expect(everything()).toEqual(before);
  });

  it.each([true, false])('ACTION-142B5EB6AC00 a parent of A deciding household B\'s order (approve=%s) is told it is not found, and nothing changes', async (approve) => {
    signInAs('parent');
    const before = everything();
    expect(await decideInvestOrderAction({ orderId: ORDER_B, approve })).toEqual({ ok: false, error: 'actions.orderNotFound' });
    expect(everything()).toEqual(before);
    expect(h.rpcCalls).toEqual([]);
  });
});
