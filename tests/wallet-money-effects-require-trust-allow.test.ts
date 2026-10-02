import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

/** Actual actions and Trust bridge; money RPCs are inert recording fakes, not SQL/RLS proof. */
const FAMILY = 'family-1';
const harness = vi.hoisted(() => ({
  db: null as unknown,
  role: 'parent',
  revalidatePath: null as unknown as Mock,
  evaluateTrust: null as unknown as Mock,
}));
vi.mock('next/cache', () => {
  harness.revalidatePath = vi.fn();
  return { revalidatePath: (...args: unknown[]) => harness.revalidatePath(...args) };
});
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({ user: { id: 'user-self' }, memberships: [], active: {
    familyId: FAMILY, role: harness.role, member: { id: 'member-self', family_id: FAMILY },
  } }),
  effectivePlanLevel: async (level: number) => level,
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db, createServiceClient: () => harness.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});
vi.mock('@/lib/trust/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/trust/server')>();
  harness.evaluateTrust = vi.fn(actual.evaluateTrust);
  return { ...actual, evaluateTrust: (...args: Parameters<typeof actual.evaluateTrust>) => harness.evaluateTrust(...args) };
});

const actions = await import('@/app/(app)/wallet/actions');
const { householdPolicyBlocked } = await import('@/lib/trust/messages');
const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
type Decision = Awaited<ReturnType<typeof import('@/lib/trust/server').evaluateTrust>>['decision'];

let db: InMemorySupabase;
let rpcCalls: { name: string; args: Record<string, unknown> }[];
const MONEY_TABLES = ['wallet_transactions', 'wallet_goals', 'gift_payments', 'parent_approvals', 'wallet_audit_logs', 'approval_requests'];
const snapshot = () => structuredClone(Object.fromEntries(MONEY_TABLES.map((name) => [name, db.table(name)])));
const policy = (over: Row = {}): Row => ({
  id: 'policy-1', family_id: FAMILY, name: 'Money needs approval', enabled: true,
  domain: 'finances', capability: 'all', subject_kind: 'everyone',
  effect: 'require_approval', conditions: {}, approval_model: 'single', required_approvals: 1, priority: 100,
  created_at: '2026-09-01T00:00:00Z', updated_at: '2026-09-01T00:00:00Z', ...over,
});
const PG_ERROR = { code: '57014', message: 'synthetic permission read timeout', details: null, hint: null };
function failRead(table: string) {
  const from = db.from.bind(db);
  (db as unknown as { from: (name: string) => unknown }).from = (name: string) => {
    const builder = from(name) as unknown as Record<string, unknown>;
    if (name === table) builder.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve({ data: null, error: PG_ERROR, count: null, status: 500, statusText: 'Error' }).then(resolve, reject);
    return builder;
  };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  rpcCalls = [];
  const record = (name: string) => (args: Record<string, unknown>) => {
    rpcCalls.push({ name, args });
    return { ok: true, transaction_id: 'txn-new', debit_transaction_id: 'txn-debit' };
  };
  db = createInMemorySupabase({ rpc: {
    wallet_transfer: record('wallet_transfer'), wallet_fund_goal: record('wallet_fund_goal'),
    wallet_approve_gift: record('wallet_approve_gift'), wallet_decide_spend: record('wallet_decide_spend'),
    wallet_decide_allowance: record('wallet_decide_allowance'), wallet_debit_spend_bucket: record('wallet_debit_spend_bucket'),
  } });
  harness.db = db;
  harness.role = 'parent';
  harness.revalidatePath.mockClear();
  harness.evaluateTrust.mockClear();
  db.seed('child_wallets', [
    { id: 'wallet-a', family_id: FAMILY, member_id: 'member-self' },
    { id: 'wallet-b', family_id: FAMILY, member_id: 'member-b' },
  ]);
  db.seed('wallet_buckets', ['spend', 'save', 'give', 'invest'].map((kind) => ({
    id: `a-${kind}`, family_id: FAMILY, child_wallet_id: 'wallet-a', kind,
  })));
  db.seed('wallet_goals', [{ id: 'goal-1', family_id: FAMILY, child_wallet_id: 'wallet-a', title: 'Bike', saved_cents: 0 }]);
  db.seed('gift_payments', [{ id: 'gift-1', family_id: FAMILY, child_wallet_id: 'wallet-a', amount_cents: 1000, status: 'pending', applied_txn_id: null }]);
  db.seed('parent_approvals', [
    { id: 'spend-1', family_id: FAMILY, kind: 'card_spend', ref_type: 'wallet_transactions', ref_id: 'held-1', amount_cents: 1000, status: 'pending' },
    { id: 'allowance-1', family_id: FAMILY, kind: 'allowance_request', ref_type: 'child_wallets', ref_id: 'wallet-a', amount_cents: 1000, status: 'pending' },
  ]);
  db.seed('wallet_transactions', [
    { id: 'balance-1', family_id: FAMILY, child_wallet_id: 'wallet-a', bucket_id: 'a-spend', amount_cents: 5000, direction: 'credit', status: 'completed' },
    { id: 'held-1', family_id: FAMILY, child_wallet_id: 'wallet-a', bucket_id: 'a-spend', amount_cents: 1000, direction: 'debit', status: 'requires_parent_approval' },
  ]);
});
afterEach(() => vi.restoreAllMocks());

const CASES = [
  { name: 'addFundsAction', capability: 'automate', rpc: null, run: () => actions.addFundsAction({ childWalletId: 'wallet-a', amountCents: 1000 }) },
  { name: 'fundGoalAction', capability: 'automate', rpc: 'wallet_fund_goal', run: () => actions.fundGoalAction({ goalId: 'goal-1', amountCents: 1000 }) },
  { name: 'approveGiftAction', capability: 'approve', rpc: 'wallet_approve_gift', run: () => actions.approveGiftAction({ giftPaymentId: 'gift-1' }) },
  { name: 'decideSpendRequestAction', capability: 'approve', rpc: 'wallet_decide_spend', run: () => actions.decideSpendRequestAction({ approvalId: 'spend-1', decision: 'approved' }) },
  { name: 'sendMoneyAction', capability: 'automate', rpc: 'wallet_transfer', run: () => actions.sendMoneyAction({ fromChildWalletId: 'wallet-a', toChildWalletId: 'wallet-b', amountCents: 1000 }) },
  { name: 'decideAllowanceRequestAction', capability: 'approve', rpc: 'wallet_decide_allowance', run: () => actions.decideAllowanceRequestAction({ approvalId: 'allowance-1', decision: 'approved' }) },
] as const;
async function trustAnswered(capability: string): Promise<Decision> {
  expect(harness.evaluateTrust).toHaveBeenCalledTimes(1);
  expect(harness.evaluateTrust.mock.calls[0][2]).toMatchObject({
    actor: { kind: 'member', id: 'member-self', role: harness.role }, domain: 'finances', capability,
    context: { amountCents: 1000 }, openApproval: false,
  });
  return (await harness.evaluateTrust.mock.results[0].value).decision;
}

describe.each(CASES)('$name requires an explicit Trust allow before a money effect', ({ run, rpc, capability }) => {
  const refused: [string, () => void, Partial<Decision>][] = [
    ['one required approval', () => db.seed('trust_policies', [policy()]), { effect: 'require_approval', basis: 'policy', requiredApprovals: 1 }],
    ['two required parents', () => db.seed('trust_policies', [policy({ approval_model: 'two_parent', required_approvals: 2 })]), { effect: 'require_approval', basis: 'policy', requiredApprovals: 2 }],
    ['unreadable policies', () => failRead('trust_policies'), { effect: 'require_approval', basis: 'degraded' }],
    ['unreadable grants', () => failRead('permission_grants'), { effect: 'require_approval', basis: 'degraded' }],
    ['explicit deny', () => db.seed('trust_policies', [policy({ effect: 'deny' })]), { effect: 'deny', basis: 'policy' }],
  ];
  it.each(refused)('refuses %s without money or success side effects', async (_label, arrange, expected) => {
    arrange();
    const before = snapshot();
    const result = await run();
    const decision = await trustAnswered(capability);
    expect(decision).toMatchObject(expected);
    // Soft assertions retain all effect evidence when the old predicate fails.
    expect.soft(result).toEqual({ ok: false, error: householdPolicyBlocked(t, decision) });
    expect.soft(snapshot()).toEqual(before);
    expect.soft(rpcCalls).toEqual([]);
    expect.soft(harness.revalidatePath).not.toHaveBeenCalled();
    // A refusal audit is expected; a wallet success audit/approval request is not.
    expect(db.table('trust_audit_logs')).toEqual([expect.objectContaining({ family_id: FAMILY, decision: expected.effect })]);
  });

  it.each(['parent', 'adult'])('preserves healthy %s role-default permission', async (role) => {
    harness.role = role;
    const before = db.table('wallet_transactions').length;
    expect(await run()).toEqual({ ok: true });
    expect(await trustAnswered(capability)).toMatchObject({ effect: 'allow', basis: 'role_default' });
    if (rpc) expect(rpcCalls).toEqual([{ name: rpc, args: expect.objectContaining({ p_family_id: FAMILY }) }]);
    else expect(db.table('wallet_transactions').slice(before)).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'completed', direction: 'credit' }),
    ]));
    expect(harness.revalidatePath).toHaveBeenCalled();
  });

  it.each(['teen', 'child', 'caregiver', 'guest'])('refuses %s before Trust or money effects', async (role) => {
    harness.role = role;
    const before = snapshot();
    expect((await run()).ok).toBe(false);
    expect(snapshot()).toEqual(before);
    expect(rpcCalls).toEqual([]);
    expect(harness.evaluateTrust).not.toHaveBeenCalled();
  });
});

describe('request and rejection boundaries stay distinct from authorizing money', () => {
  it.each([
    ['spend', () => actions.decideSpendRequestAction({ approvalId: 'spend-1', decision: 'rejected' }), 'wallet_decide_spend'],
    ['allowance', () => actions.decideAllowanceRequestAction({ approvalId: 'allowance-1', decision: 'rejected' }), 'wallet_decide_allowance'],
  ] as const)('still allows a parent to reject %s without a Trust approval', async (_label, run, rpc) => {
    db.seed('trust_policies', [policy()]);
    expect(await run()).toEqual({ ok: true });
    expect(harness.evaluateTrust).not.toHaveBeenCalled();
    expect(rpcCalls).toEqual([{ name: rpc, args: expect.objectContaining({ p_decision: 'rejected' }) }]);
  });
  it('a child can still create an allowance request, without executing a credit', async () => {
    harness.role = 'child';
    db.seed('trust_policies', [policy()]);
    expect(await actions.requestAllowanceAction({ childWalletId: 'wallet-a', amountCents: 1000 })).toEqual({ ok: true });
    expect(db.table('parent_approvals').at(-1)).toMatchObject({ status: 'pending', kind: 'allowance_request' });
    expect(rpcCalls).toEqual([]);
    expect(harness.evaluateTrust).not.toHaveBeenCalled();
  });
  it('a spend request requiring approval requests a held debit and files a pending approval', async () => {
    db.seed('trust_policies', [policy()]);
    expect(await actions.requestSpendAction({ childWalletId: 'wallet-a', amountCents: 1000, description: 'Trip' })).toEqual({ ok: true, pendingApproval: true });
    expect(await trustAnswered('automate')).toMatchObject({ effect: 'require_approval', basis: 'policy' });
    expect(rpcCalls).toEqual([{ name: 'wallet_debit_spend_bucket', args: expect.objectContaining({ p_requires_approval: true }) }]);
    expect(db.table('parent_approvals').at(-1)).toMatchObject({ status: 'pending', kind: 'card_spend' });
  });
});
