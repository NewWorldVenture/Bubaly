import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

/**
 * requestAllowanceAction and decideAllowanceRequestAction
 * (app/(app)/wallet/actions.ts), run as code. `wallet-atomic-persistence.test.ts`
 * and `wallet-money-action-boundaries.test.ts` read their source text; nothing
 * ran either action. This drives both against an in-memory store and a
 * synthetic `wallet_decide_allowance` RPC, through the real `decideAllowance`
 * wrapper and the real message catalogue, and asserts what each one reads,
 * writes, sends and answers.
 *
 * Finding: MAIN-F-F07 (money server actions with no test). Register B:
 * ACTION-8AA29BB74838 (requestAllowanceAction), ACTION-B474AE170511
 * (decideAllowanceRequestAction).
 *
 * The RPC is synthetic: the credit, its split across buckets, the row lock and
 * the audit row are `wallet_decide_allowance`'s (0205) and are not exercised
 * here. Nor is row-level security on `parent_approvals`.
 */

const FAMILY = 'family-1';
const harness = vi.hoisted(() => ({
  db: null as unknown,
  role: 'child',
  decide: null as null | ((args: Record<string, unknown>) => unknown),
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

const { requestAllowanceAction, decideAllowanceRequestAction } = await import('@/app/(app)/wallet/actions');
const { decideAllowance } = await import('@/lib/wallet/server');
const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
const { describeActionError } = await import('@/lib/supabase/errors');
const { householdPolicyBlocked } = await import('@/lib/trust/messages');
const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);

const DENY_POLICY = { effect: 'deny', reason: 'Blocked by policy: Finances.', reasonKey: 'trust.denyBlockedByPolicy', reasonParams: { domain: 'finances' }, basis: 'policy' } as const;
const PG_ERROR = { code: '57014', message: 'canceling statement due to statement timeout', details: null, hint: null };
const NON_MANAGERS = ['teen', 'child', 'caregiver', 'guest'];

let db: InMemorySupabase;
let decideCalls: Record<string, unknown>[];

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  decideCalls = [];
  db = createInMemorySupabase({
    rpc: { wallet_decide_allowance: (args) => { decideCalls.push(args); return harness.decide?.(args); } },
  });
  harness.db = db;
  harness.role = 'child';
  harness.decide = () => ({ ok: true, decision: 'approved', transaction_id: 'txn-credit' });
  harness.decision = { effect: 'allow', reason: 'Allowed.', basis: 'role_default' };
  harness.revalidatePath.mockClear();
  harness.evaluateTrust.mockClear();
  db.seed('child_wallets', [
    { id: 'wallet-self', family_id: FAMILY, member_id: 'member-self' },
    { id: 'wallet-sibling', family_id: FAMILY, member_id: 'member-sibling' },
    { id: 'wallet-x', family_id: 'family-2', member_id: 'member-x' },
  ]);
});

/** Replace one table's builder method so its call answers `reply`. */
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

/** What the real wrapper answers for this RPC reply, so the action is held to it without restating its wording. */
async function wrapperSays(reply: () => unknown) {
  const side = createInMemorySupabase({ rpc: { wallet_decide_allowance: reply } });
  const result = await decideAllowance(side as unknown as Parameters<typeof decideAllowance>[0], {
    familyId: FAMILY, approvalId: 'appr-1', decision: 'approved', actorId: 'user-self',
  });
  expect(result.ok).toBe(false);
  return result.error;
}

const approvals = () => db.table('parent_approvals');
const ask = (over: Partial<Parameters<typeof requestAllowanceAction>[0]> = {}) =>
  requestAllowanceAction({ childWalletId: 'wallet-self', amountCents: 2_500, ...over });

describe('requestAllowanceAction (ACTION-8AA29BB74838)', () => {
  it('files a pending request against the child’s own wallet, as the user, and refreshes the wallet', async () => {
    expect(await ask({ reason: '  Zoo trip  ' })).toEqual({ ok: true });

    expect(approvals()).toHaveLength(1);
    expect(approvals()[0]).toMatchObject({
      family_id: FAMILY, kind: 'allowance_request', ref_type: 'child_wallets', ref_id: 'wallet-self',
      amount_cents: 2_500, status: 'pending', requested_by: 'user-self', note: 'Zoo trip',
    });
    expect(harness.revalidatePath).toHaveBeenCalledTimes(1);
    expect(harness.revalidatePath).toHaveBeenCalledWith('/wallet');
  });

  it('moves no money: no Trust check, no RPC, no ledger row', async () => {
    await ask();

    expect(harness.evaluateTrust).not.toHaveBeenCalled();
    expect(decideCalls).toHaveLength(0);
    expect(db.table('wallet_transactions')).toHaveLength(0);
  });

  it.each([
    ['no reason', undefined],
    ['a blank reason', '   '],
  ])('%s is stored as no note', async (_label, reason) => {
    expect(await ask({ reason })).toEqual({ ok: true });
    expect(approvals()[0].note).toBeNull();
  });

  it('asks for whole cents only', async () => {
    expect(await ask({ amountCents: 2_500.9 })).toEqual({ ok: true });
    expect(approvals()[0].amount_cents).toBe(2_500);
  });

  it.each([0, -100, 0.9, Number.NaN, Number.POSITIVE_INFINITY])('refuses an amount of %s before reading anything', async (amountCents) => {
    expect(await ask({ amountCents })).toEqual({ ok: false, error: t('actions.enterAnAmountGreaterThan') });
    expect(db.log).toHaveLength(0);
    expect(approvals()).toHaveLength(0);
  });

  it.each(NON_MANAGERS)('a %s may ask for their own wallet', async (role) => {
    harness.role = role;
    expect(await ask()).toEqual({ ok: true });
    expect(approvals()).toHaveLength(1);
  });

  it.each(NON_MANAGERS)('a %s may not ask on a sibling’s wallet', async (role) => {
    harness.role = role;

    expect(await ask({ childWalletId: 'wallet-sibling' })).toEqual({ ok: false, error: t('actions.notAuthorized') });
    expect(approvals()).toHaveLength(0);
    expect(harness.revalidatePath).not.toHaveBeenCalled();
  });

  it.each(['parent', 'adult'])('a %s may file one on any of the family’s children’s wallets', async (role) => {
    harness.role = role;

    expect(await ask({ childWalletId: 'wallet-sibling' })).toEqual({ ok: true });
    expect(approvals()[0]).toMatchObject({ ref_id: 'wallet-sibling', requested_by: 'user-self' });
  });

  it.each([
    ['another family’s wallet', 'wallet-x', 'parent'],
    ['another family’s wallet', 'wallet-x', 'child'],
    ['a wallet that does not exist', 'wallet-missing', 'parent'],
  ])('%s is not found (as a %s), and nothing is filed', async (_label, childWalletId, role) => {
    harness.role = role;

    expect(await ask({ childWalletId })).toEqual({ ok: false, error: t('actions.walletNotFound') });
    expect(approvals()).toHaveLength(0);
  });

  it('a wallet read failure is a failure in words, with nothing filed', async () => {
    override('child_wallets', 'maybeSingle', { error: PG_ERROR });

    expect(await ask()).toEqual({ ok: false, error: describeActionError(PG_ERROR, t('actions.couldNotLoadThatWallet')) });
    expect(approvals()).toHaveLength(0);
  });

  it('a refused insert is a failure in words, and refreshes nothing', async () => {
    const denied = { code: '42501', message: 'new row violates row-level security policy for table "parent_approvals"', details: null, hint: null };
    override('parent_approvals', 'insert', { error: denied });

    expect(await ask()).toEqual({ ok: false, error: describeActionError(denied, t('actions.couldNotCreateThatAllowance')) });
    expect(harness.revalidatePath).not.toHaveBeenCalled();
  });
});

describe('decideAllowanceRequestAction (ACTION-B474AE170511)', () => {
  beforeEach(() => {
    harness.role = 'parent';
    db.seed('parent_approvals', [
      { id: 'appr-1', family_id: FAMILY, status: 'pending', kind: 'allowance_request', ref_type: 'child_wallets', ref_id: 'wallet-self', amount_cents: 2_500, note: 'Zoo trip' },
      { id: 'appr-quiet', family_id: FAMILY, status: 'pending', kind: 'allowance_request', ref_type: 'child_wallets', ref_id: 'wallet-self', amount_cents: 500, note: null },
      { id: 'appr-done', family_id: FAMILY, status: 'rejected', kind: 'allowance_request', ref_type: 'child_wallets', ref_id: 'wallet-self', amount_cents: 2_500, note: null },
      { id: 'appr-spend', family_id: FAMILY, status: 'pending', kind: 'card_spend', ref_type: 'wallet_transactions', ref_id: 'txn-held', amount_cents: 1_200, note: null },
      { id: 'appr-badref', family_id: FAMILY, status: 'pending', kind: 'allowance_request', ref_type: 'wallet_transactions', ref_id: 'txn-held', amount_cents: 2_500, note: null },
      { id: 'appr-noref', family_id: FAMILY, status: 'pending', kind: 'allowance_request', ref_type: 'child_wallets', ref_id: null, amount_cents: 2_500, note: null },
      { id: 'appr-zero', family_id: FAMILY, status: 'pending', kind: 'allowance_request', ref_type: 'child_wallets', ref_id: 'wallet-self', amount_cents: 0, note: null },
      { id: 'appr-null', family_id: FAMILY, status: 'pending', kind: 'allowance_request', ref_type: 'child_wallets', ref_id: 'wallet-self', amount_cents: null, note: null },
      { id: 'appr-x', family_id: 'family-2', status: 'pending', kind: 'allowance_request', ref_type: 'child_wallets', ref_id: 'wallet-x', amount_cents: 2_500, note: null },
    ]);
  });

  const decide = (over: Partial<Parameters<typeof decideAllowanceRequestAction>[0]> = {}) =>
    decideAllowanceRequestAction({ approvalId: 'appr-1', decision: 'approved', ...over });

  it('a parent’s approval goes to the RPC once, as the user, carrying the request’s own note, and refreshes the wallet', async () => {
    expect(await decide()).toEqual({ ok: true });

    expect(decideCalls).toEqual([{ p_family_id: FAMILY, p_approval_id: 'appr-1', p_decision: 'approved', p_note: 'Zoo trip', p_actor_id: 'user-self' }]);
    expect(harness.revalidatePath).toHaveBeenCalledTimes(1);
    expect(harness.revalidatePath).toHaveBeenCalledWith('/wallet');
  });

  it('checks the approver with the Trust Engine: finances, approve, the requested amount', async () => {
    await decide();

    expect(harness.evaluateTrust).toHaveBeenCalledTimes(1);
    const [client, family, request] = harness.evaluateTrust.mock.calls[0] as [unknown, string, Record<string, unknown>];
    expect(client).toBe(db);
    expect(family).toBe(FAMILY);
    expect(request).toMatchObject({
      actor: { kind: 'member', id: 'member-self', role: 'parent' },
      domain: 'finances', capability: 'approve', context: { amountCents: 2_500 }, openApproval: false,
    });
  });

  it('the parent’s own note replaces the request’s', async () => {
    expect(await decide({ note: 'Enjoy it' })).toEqual({ ok: true });
    expect(decideCalls[0]).toMatchObject({ p_note: 'Enjoy it' });
  });

  it('with no note on either side, none is sent', async () => {
    expect(await decide({ approvalId: 'appr-quiet' })).toEqual({ ok: true });
    expect(decideCalls[0]).toMatchObject({ p_approval_id: 'appr-quiet', p_note: null });
  });

  it('a rejection goes to the RPC without a Trust check', async () => {
    expect(await decide({ decision: 'rejected', note: 'Not this week' })).toEqual({ ok: true });

    expect(decideCalls).toEqual([{ p_family_id: FAMILY, p_approval_id: 'appr-1', p_decision: 'rejected', p_note: 'Not this week', p_actor_id: 'user-self' }]);
    expect(harness.evaluateTrust).not.toHaveBeenCalled();
  });

  it('an adult may decide too', async () => {
    harness.role = 'adult';
    expect(await decide()).toEqual({ ok: true });
    expect(decideCalls).toHaveLength(1);
  });

  it.each(NON_MANAGERS)('refuses a %s before reading anything', async (role) => {
    harness.role = role;

    expect(await decide()).toEqual({ ok: false, error: t('actions.onlyAParentGuardianCan19') });
    expect(db.log).toHaveLength(0);
    expect(decideCalls).toHaveLength(0);
    expect(harness.revalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    ['another family’s request', 'appr-x', 'actions.requestNotFound'],
    ['a request that does not exist', 'appr-missing', 'actions.requestNotFound'],
    ['a request already decided', 'appr-done', 'actions.thisRequestWasAlreadyDecided'],
    ['a spend request', 'appr-spend', 'actions.wrongRequestKind'],
    ['a request pointing at something other than a wallet', 'appr-badref', 'actions.malformedRequest'],
    ['a request pointing at no wallet', 'appr-noref', 'actions.malformedRequest'],
  ])('%s is refused before Trust or the RPC', async (_label, approvalId, key) => {
    expect(await decide({ approvalId })).toEqual({ ok: false, error: t(key) });
    expect(db.log.map((entry) => entry.table)).toEqual(['parent_approvals']);
    expect(harness.evaluateTrust).not.toHaveBeenCalled();
    expect(decideCalls).toHaveLength(0);
  });

  it.each(['appr-zero', 'appr-null'])('approving a request with no amount (%s) is refused before Trust or the RPC', async (approvalId) => {
    expect(await decide({ approvalId })).toEqual({ ok: false, error: t('actions.invalidAmountOnThisRequest') });
    expect(harness.evaluateTrust).not.toHaveBeenCalled();
    expect(decideCalls).toHaveLength(0);
  });

  it('rejecting a request with no amount is still allowed', async () => {
    expect(await decide({ approvalId: 'appr-zero', decision: 'rejected' })).toEqual({ ok: true });
    expect(decideCalls[0]).toMatchObject({ p_approval_id: 'appr-zero', p_decision: 'rejected' });
  });

  it('a request read failure is a failure in words', async () => {
    override('parent_approvals', 'maybeSingle', { error: PG_ERROR });

    expect(await decide()).toEqual({ ok: false, error: describeActionError(PG_ERROR, t('actions.couldNotLoadThatAllowance')) });
    expect(decideCalls).toHaveLength(0);
  });

  it('a Trust denial of the approver stops an approval before the RPC', async () => {
    harness.decision = DENY_POLICY;

    expect(await decide()).toEqual({ ok: false, error: householdPolicyBlocked(t, DENY_POLICY as never) });
    expect(decideCalls).toHaveLength(0);
    expect(harness.revalidatePath).not.toHaveBeenCalled();
  });

  it('a Trust answer short of a denial does not stop an approval', async () => {
    harness.decision = { effect: 'require_approval', reason: 'Needs a second parent.', basis: 'policy' };

    expect(await decide()).toEqual({ ok: true });
    expect(decideCalls).toHaveLength(1);
  });

  it('a Trust denial does not stop a rejection, which moves no money', async () => {
    harness.decision = DENY_POLICY;

    expect(await decide({ decision: 'rejected' })).toEqual({ ok: true });
    expect(decideCalls[0]).toMatchObject({ p_decision: 'rejected' });
  });

  it.each([
    [{ ok: false, reason: 'already_processed' }],
    [{ ok: false, reason: 'forbidden' }],
    [{ ok: false, reason: 'not_found' }],
    [{ ok: false, reason: 'wallet_buckets_missing' }],
    [{ ok: false }],
  ])('passes on the wrapper’s answer to %j and does not claim success', async (reply) => {
    harness.decide = () => reply;

    expect(await decide()).toEqual({ ok: false, error: await wrapperSays(() => reply) });
    expect(decideCalls).toHaveLength(1);
    expect(harness.revalidatePath).not.toHaveBeenCalled();
  });

  it('a thrown RPC error is a failure, without the database’s own text', async () => {
    harness.decide = () => { throw new Error('deadlock detected'); };

    const result = await decide();

    expect(result).toEqual({ ok: false, error: await wrapperSays(() => { throw new Error('deadlock detected'); }) });
    expect(result.error).not.toContain('deadlock');
    expect(harness.revalidatePath).not.toHaveBeenCalled();
  });
});
