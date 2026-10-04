import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

// Real action and Trust bridge/engine; the recording RPC does not execute SQL or settle funds.
const FAMILY = 'family-a';
const harness = vi.hoisted(() => ({
  db: null as unknown, role: 'parent',
  revalidatePath: null as unknown as Mock, evaluateTrust: null as unknown as Mock,
}));
vi.mock('next/cache', () => {
  harness.revalidatePath = vi.fn();
  return { revalidatePath: (...args: unknown[]) => harness.revalidatePath(...args) };
});
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({ user: { id: 'user-self' }, active: {
    familyId: FAMILY, role: harness.role, member: { id: 'member-self', family_id: FAMILY },
  } }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});
vi.mock('@/lib/trust/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/trust/server')>();
  harness.evaluateTrust = vi.fn(actual.evaluateTrust);
  return { ...actual, evaluateTrust: (...args: Parameters<typeof actual.evaluateTrust>) => harness.evaluateTrust(...args) };
});

const { decideInvestOrderAction } = await import('@/app/(app)/wallet/invest/actions');
const { householdPolicyBlocked } = await import('@/lib/trust/messages');
const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
type Decision = Awaited<ReturnType<typeof import('@/lib/trust/server').evaluateTrust>>['decision'];

let db: InMemorySupabase;
let rpcCalls: Record<string, unknown>[];
const state = () => structuredClone(Object.fromEntries(
  ['invest_orders', 'invest_holdings', 'wallet_transactions', 'wallet_audit_logs', 'approval_requests']
    .map((name) => [name, db.table(name)]),
));
const policy = (over: Row = {}): Row => ({
  id: 'policy-1', family_id: FAMILY, name: 'Investing needs approval', enabled: true,
  domain: 'finances', capability: 'approve', subject_kind: 'everyone', effect: 'require_approval',
  conditions: {}, approval_model: 'single', required_approvals: 1, priority: 100,
  created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z', ...over,
});
function failRead(table: string) {
  const from = db.from.bind(db);
  vi.spyOn(db, 'from').mockImplementation((name) => {
    const query = from(name);
    if (name === table) vi.spyOn(query, 'then').mockImplementation((resolve, reject) => Promise.resolve({
      data: null, error: { code: '57014', message: 'synthetic Trust read timeout', details: null, hint: null },
      count: null, status: 500, statusText: 'Error',
    }).then(resolve, reject));
    return query;
  });
}
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  rpcCalls = [];
  db = createInMemorySupabase({ rpc: { invest_decide_order: (args) => {
    rpcCalls.push(args);
    return { ok: true };
  } } });
  harness.db = db;
  harness.role = 'parent';
  harness.revalidatePath.mockClear();
  harness.evaluateTrust.mockClear();
  db.seed('invest_orders', [{
    id: 'order-a', family_id: FAMILY, child_wallet_id: 'wallet-a', asset_id: 'asset-a',
    side: 'buy', shares: 2, price_cents: 500, amount_cents: 1000, status: 'pending', requested_by: 'user-child',
  }]);
  db.seed('invest_holdings', [{ id: 'holding-a', family_id: FAMILY, child_wallet_id: 'wallet-a', asset_id: 'asset-a', shares: 2 }]);
  db.seed('wallet_transactions', [{ id: 'balance-a', family_id: FAMILY, child_wallet_id: 'wallet-a', amount_cents: 5000, direction: 'credit', status: 'completed' }]);
});
afterEach(() => vi.restoreAllMocks());

async function trustAnswered(): Promise<Decision> {
  expect(harness.evaluateTrust).toHaveBeenCalledTimes(1);
  expect(harness.evaluateTrust.mock.calls[0].slice(1)).toEqual([FAMILY, expect.objectContaining({
    actor: { kind: 'member', id: 'member-self', role: harness.role },
    domain: 'finances', capability: 'approve', context: { amountCents: 1000 }, openApproval: false,
  })]);
  return (await harness.evaluateTrust.mock.results[0].value).decision;
}

describe.each(['buy', 'sell'])('%s order approval requires explicit Trust allow', (side) => {
  beforeEach(() => { db.table('invest_orders')[0].side = side; });
  const refused: [string, () => void, Partial<Decision>][] = [
    ['one approval', () => db.seed('trust_policies', [policy()]), { effect: 'require_approval', basis: 'policy', requiredApprovals: 1 }],
    ['two distinct parents', () => db.seed('trust_policies', [policy({ approval_model: 'two_parent', required_approvals: 2 })]), { effect: 'require_approval', basis: 'policy', requiredApprovals: 2 }],
    ['unreadable policies', () => failRead('trust_policies'), { effect: 'require_approval', basis: 'degraded' }],
    ['unreadable grants', () => failRead('permission_grants'), { effect: 'require_approval', basis: 'degraded' }],
    ['explicit deny', () => db.seed('trust_policies', [policy({ effect: 'deny' })]), { effect: 'deny', basis: 'policy' }],
  ];
  it.each(refused)('refuses %s before the settlement RPC or success effects', async (_label, arrange, expected) => {
    arrange();
    const before = state();
    const result = await decideInvestOrderAction({ orderId: 'order-a', approve: true });
    const decision = await trustAnswered();
    expect(decision).toMatchObject(expected);
    expect.soft(result).toEqual({ ok: false, error: householdPolicyBlocked(t, decision) });
    expect.soft(rpcCalls).toEqual([]);
    expect.soft(state()).toEqual(before);
    expect.soft(harness.revalidatePath).not.toHaveBeenCalled();
    // The real bridge records its refusal; it must not open a generic approval or a wallet success audit.
    expect(db.table('trust_audit_logs')).toEqual([expect.objectContaining({ family_id: FAMILY, decision: expected.effect })]);
  });
  it.each(['parent', 'adult'])('preserves healthy %s role-default approval', async (role) => {
    harness.role = role;
    expect(await decideInvestOrderAction({ orderId: 'order-a', approve: true })).toEqual({ ok: true });
    expect(await trustAnswered()).toMatchObject({ effect: 'allow', basis: 'role_default' });
    expect(rpcCalls).toEqual([{ p_order_id: 'order-a', p_approve: true }]);
    expect(harness.revalidatePath).toHaveBeenCalledExactlyOnceWith('/wallet/invest');
  });
  it.each(['policy', 'grant'])('preserves explicit %s allow', async (kind) => {
    if (kind === 'policy') db.seed('trust_policies', [policy({ effect: 'allow' })]);
    else db.seed('permission_grants', [{ family_id: FAMILY, member_id: 'member-self', domain: 'finances', capability: 'approve', effect: 'allow' }]);
    expect(await decideInvestOrderAction({ orderId: 'order-a', approve: true })).toEqual({ ok: true });
    expect(await trustAnswered()).toMatchObject({ effect: 'allow', basis: kind === 'policy' ? 'policy' : 'allow_grant' });
    expect(rpcCalls).toEqual([{ p_order_id: 'order-a', p_approve: true }]);
  });
  it.each(['require_approval', 'deny', 'degraded'])('preserves rejection while policy is %s', async (effect) => {
    if (effect === 'degraded') failRead('trust_policies');
    else db.seed('trust_policies', [policy({ effect })]);
    const before = state();
    expect(await decideInvestOrderAction({ orderId: 'order-a', approve: false })).toEqual({ ok: true });
    expect(rpcCalls).toEqual([{ p_order_id: 'order-a', p_approve: false }]);
    expect(harness.evaluateTrust).not.toHaveBeenCalled();
    expect(state()).toEqual(before); // Recording fake; no SQL/domain rejection is claimed.
    expect(db.table('trust_audit_logs')).toEqual([]);
  });
});

it.each(['teen', 'child', 'caregiver', 'guest'].flatMap((role) => [true, false].map((approve) => ({ role, approve }))))(
  'refuses $role (approve=$approve) before Trust or RPC', async ({ role, approve }) => {
    harness.role = role;
    const before = state();
    expect((await decideInvestOrderAction({ orderId: 'order-a', approve })).ok).toBe(false);
    expect(harness.evaluateTrust).not.toHaveBeenCalled();
    expect(rpcCalls).toEqual([]);
    expect(state()).toEqual(before);
    expect(harness.revalidatePath).not.toHaveBeenCalled();
  },
);
it.each(['foreign-family', 'already-filled'])('refuses a %s order before Trust or RPC', async (kind) => {
  if (kind === 'foreign-family') db.table('invest_orders')[0].family_id = 'family-b';
  else db.table('invest_orders')[0].status = 'filled';
  const before = state();
  expect((await decideInvestOrderAction({ orderId: 'order-a', approve: true })).ok).toBe(false);
  expect(harness.evaluateTrust).not.toHaveBeenCalled();
  expect(rpcCalls).toEqual([]);
  expect(state()).toEqual(before);
  expect(harness.revalidatePath).not.toHaveBeenCalled();
});
