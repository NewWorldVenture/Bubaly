import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

/**
 * requestSpendAction and decideSpendRequestAction (app/(app)/wallet/actions.ts),
 * run as code. `a-filtered-delete-is-not-a-deletion.test.ts` reads the rollback's
 * source text; nothing ran either action. This drives both against an in-memory
 * store and synthetic `wallet_debit_spend_bucket` / `wallet_decide_spend` RPCs,
 * through the real `bucketBalanceCents`, `debitSpendBucket` and `decideSpend`
 * wrappers and the real message catalogue, and asserts what each one reads,
 * sends, writes and answers.
 *
 * Finding: MAIN-F-F07 (money server actions with no test). Register B:
 * ACTION-ABA436EAC1FB (requestSpendAction), ACTION-3DB849535F18
 * (decideSpendRequestAction).
 *
 * The RPCs are synthetic. On the real schema `wallet_debit_spend_bucket` (0342)
 * refuses a caller who is not a family manager with `forbidden`, so a child's
 * request does not reach the ledger today; the cases below that file a child's
 * request assert what the action SENDS, and the `forbidden` case asserts what
 * it answers when the database refuses. Nothing here establishes the lock, the
 * balance re-check or row-level security.
 */

const FAMILY = 'family-1';
const harness = vi.hoisted(() => ({
  db: null as unknown,
  role: 'parent',
  debit: null as null | ((args: Record<string, unknown>, db: unknown) => unknown),
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

const { requestSpendAction, decideSpendRequestAction } = await import('@/app/(app)/wallet/actions');
const { bucketBalanceCents, debitSpendBucket, decideSpend } = await import('@/lib/wallet/server');
const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
const { describeActionError } = await import('@/lib/supabase/errors');
const { householdPolicyBlocked } = await import('@/lib/trust/messages');
const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);

const DENY_POLICY = { effect: 'deny', reason: 'Blocked by policy: Finances.', reasonKey: 'trust.denyBlockedByPolicy', reasonParams: { domain: 'finances' }, basis: 'policy' } as const;
const PG_ERROR = { code: '57014', message: 'canceling statement due to statement timeout', details: null, hint: null };
const NON_MANAGERS = ['teen', 'child', 'caregiver', 'guest'];

let db: InMemorySupabase;
let debitCalls: Record<string, unknown>[];
let decideCalls: Record<string, unknown>[];

/**
 * What the synthetic debit RPC does by default: write the one debit row it was
 * asked for, held or completed, and say so. That row is what the rollback finds.
 */
function postDebit(args: Record<string, unknown>, store: unknown) {
  (store as InMemorySupabase).table('wallet_transactions').push({
    id: 'txn-new', family_id: args.p_family_id, child_wallet_id: args.p_child_wallet_id, bucket_id: 'a-spend',
    direction: 'debit', amount_cents: args.p_amount,
    status: args.p_requires_approval ? 'requires_parent_approval' : 'completed',
  });
  return { ok: true, transaction_id: 'txn-new' };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  debitCalls = [];
  decideCalls = [];
  db = createInMemorySupabase({
    rpc: {
      wallet_debit_spend_bucket: (args, store) => { debitCalls.push(args); return harness.debit?.(args, store); },
      wallet_decide_spend: (args) => { decideCalls.push(args); return harness.decide?.(args); },
    },
  });
  harness.db = db;
  harness.role = 'parent';
  harness.debit = postDebit;
  harness.decide = () => ({ ok: true });
  harness.decision = { effect: 'allow', reason: 'Allowed.', basis: 'role_default' };
  harness.revalidatePath.mockClear();
  harness.evaluateTrust.mockClear();
  // wallet-a is the caller's own wallet, so every accepted request below is a
  // request against one's own wallet. wallet-b is another member's. Whether a
  // child or teen may file a request against a sibling's wallet is policy that
  // is not settled, and no case here asserts either answer.
  db.seed('child_wallets', [
    { id: 'wallet-a', family_id: FAMILY, member_id: 'member-self' },
    { id: 'wallet-b', family_id: FAMILY, member_id: 'member-b' },
    { id: 'wallet-x', family_id: 'family-2', member_id: 'member-x' },
  ]);
  db.seed('wallet_buckets', [
    { id: 'a-spend', family_id: FAMILY, child_wallet_id: 'wallet-a', kind: 'spend' },
    { id: 'a-save', family_id: FAMILY, child_wallet_id: 'wallet-a', kind: 'save' },
    { id: 'x-spend', family_id: 'family-2', child_wallet_id: 'wallet-x', kind: 'spend' },
  ]);
  // wallet-a's Spend bucket holds 100.00 completed. Nothing else below is spendable
  // from it: a held debit, a pending credit, another bucket, another family.
  db.seed('wallet_transactions', [
    { id: 't1', family_id: FAMILY, bucket_id: 'a-spend', direction: 'credit', amount_cents: 12_000, status: 'completed' },
    { id: 't2', family_id: FAMILY, bucket_id: 'a-spend', direction: 'debit', amount_cents: 2_000, status: 'completed' },
    { id: 't3', family_id: FAMILY, bucket_id: 'a-spend', direction: 'debit', amount_cents: 3_000, status: 'requires_parent_approval' },
    { id: 't4', family_id: FAMILY, bucket_id: 'a-spend', direction: 'credit', amount_cents: 50_000, status: 'pending' },
    { id: 't5', family_id: FAMILY, bucket_id: 'a-save', direction: 'credit', amount_cents: 90_000, status: 'completed' },
    { id: 't6', family_id: 'family-2', bucket_id: 'x-spend', direction: 'credit', amount_cents: 90_000, status: 'completed' },
  ]);
});

/** Replace one table's builder method so its call answers `reply`. */
function override(table: string, method: 'insert' | 'maybeSingle', reply: Record<string, unknown>, before?: () => void) {
  const from = db.from.bind(db);
  (db as unknown as { from: (name: string) => unknown }).from = (name: string) => {
    const builder = from(name) as unknown as Record<string, unknown>;
    if (name !== table) return builder;
    const answer = { data: null, count: null, status: 500, statusText: 'Error', ...reply };
    if (method === 'insert') builder.insert = () => ({ then: (resolve: (v: unknown) => unknown) => { before?.(); return Promise.resolve(answer).then(resolve); } });
    if (method === 'maybeSingle') builder.maybeSingle = async () => answer;
    return builder;
  };
}

/** What the real wrapper answers for this RPC reply, so the action is held to it without restating its wording. */
async function wrapperSays(rpcName: 'wallet_debit_spend_bucket' | 'wallet_decide_spend', reply: () => unknown) {
  const side = createInMemorySupabase({ rpc: { [rpcName]: reply } });
  const client = side as unknown as Parameters<typeof decideSpend>[0];
  const result = rpcName === 'wallet_debit_spend_bucket'
    ? await debitSpendBucket(client, { familyId: FAMILY, childWalletId: 'wallet-a', amountCents: 100, type: 'card_spend', description: 'x', createdBy: 'user-self' })
    : await decideSpend(client, { familyId: FAMILY, approvalId: 'appr-1', decision: 'approved', actorId: 'user-self' });
  expect(result.ok).toBe(false);
  return result.error;
}

/** What the real balance read answers on the store as it stands, so the action is held to passing it on. */
async function balanceSays() {
  const result = await bucketBalanceCents(db as unknown as Parameters<typeof bucketBalanceCents>[0], { familyId: FAMILY, childWalletId: 'wallet-a', kind: 'spend' });
  expect(result.error).toBeTruthy();
  return result.error;
}

/** A string with at least one non-space character: `undefined` and `null` fail, not just blanks. */
function expectNonblankText(value: unknown) {
  expect(typeof value).toBe('string');
  expect((value as string).trim()).not.toBe('');
}

const approvals = () => db.table('parent_approvals');
const txn = (id: string) => db.table('wallet_transactions').find((row) => row.id === id) as Row;
const ask = (over: Partial<Parameters<typeof requestSpendAction>[0]> = {}) =>
  requestSpendAction({ childWalletId: 'wallet-a', amountCents: 1_200, description: 'Snacks', ...over });

describe('requestSpendAction (ACTION-ABA436EAC1FB)', () => {
  describe('a parent under the threshold spends directly', () => {
    it('posts one completed debit through the RPC, files no approval, and refreshes the wallet', async () => {
      expect(await ask()).toEqual({ ok: true });

      expect(debitCalls).toEqual([{
        p_family_id: FAMILY, p_child_wallet_id: 'wallet-a', p_amount: 1_200, p_type: 'card_spend',
        p_description: 'Snacks', p_actor_id: 'user-self', p_requires_approval: false, p_approved_by: null,
        p_related_type: 'spend_request', p_related_id: null,
        p_metadata: { requested_by_member: 'member-self', trust_basis: 'role_default', trust_effect: 'allow' },
      }]);
      expect(txn('txn-new')).toMatchObject({ status: 'completed', amount_cents: 1_200 });
      expect(approvals()).toHaveLength(0);
      expect(harness.revalidatePath).toHaveBeenCalledTimes(1);
      expect(harness.revalidatePath).toHaveBeenCalledWith('/wallet');
    });

    it('asks the Trust Engine as the member, about finances, for this amount, without opening its own approval', async () => {
      await ask();

      expect(harness.evaluateTrust).toHaveBeenCalledTimes(1);
      const [client, family, request] = harness.evaluateTrust.mock.calls[0] as [unknown, string, Record<string, unknown>];
      expect(client).toBe(db);
      expect(family).toBe(FAMILY);
      expect(request).toMatchObject({
        actor: { kind: 'member', id: 'member-self', role: 'parent' },
        domain: 'finances', capability: 'automate', context: { amountCents: 1_200 }, openApproval: false,
      });
      expect(request.title).toEqual(expect.stringContaining('12.00'));
      expect(request.title).toEqual(expect.stringContaining('Snacks'));
    });

    it('an adult is a manager too', async () => {
      harness.role = 'adult';
      expect(await ask()).toEqual({ ok: true });
      expect(debitCalls[0]).toMatchObject({ p_requires_approval: false });
    });

    it('sends whole cents and a trimmed description', async () => {
      expect(await ask({ amountCents: 1_250.9, description: '  Comic book  ' })).toEqual({ ok: true });
      expect(debitCalls[0]).toMatchObject({ p_amount: 1_250, p_description: 'Comic book' });
    });

    it('never sends a blank description', async () => {
      expect(await ask({ description: '   ' })).toEqual({ ok: true });
      expectNonblankText(debitCalls[0].p_description);
    });

    it.each([undefined, null, '', '   '])('the nonblank check itself rejects a description of %j', (value) => {
      expect(() => expectNonblankText(value)).toThrow();
    });
  });

  describe('when a parent’s approval is needed', () => {
    it('over the default 50.00 threshold: a held debit and a pending approval that points at it', async () => {
      const result = await ask({ amountCents: 5_001, description: 'Headphones' });

      expect(result).toEqual({ ok: true, pendingApproval: true });
      expect(debitCalls).toHaveLength(1);
      expect(debitCalls[0]).toMatchObject({ p_amount: 5_001, p_requires_approval: true, p_actor_id: 'user-self' });
      expect(txn('txn-new')).toMatchObject({ status: 'requires_parent_approval' });
      expect(approvals()).toHaveLength(1);
      expect(approvals()[0]).toMatchObject({
        family_id: FAMILY, kind: 'card_spend', ref_type: 'wallet_transactions', ref_id: 'txn-new',
        amount_cents: 5_001, status: 'pending', requested_by: 'user-self', note: 'Headphones',
      });
      expect(harness.revalidatePath).toHaveBeenCalledWith('/wallet');
    });

    it('exactly the threshold is still a direct spend; one cent over is held', async () => {
      expect(await ask({ amountCents: 5_000 })).toEqual({ ok: true });
      expect(debitCalls[0]).toMatchObject({ p_requires_approval: false });
      // That spend really posted; take it back out so the second one sees 100.00 again.
      db.replace('wallet_transactions', db.table('wallet_transactions').filter((row) => row.id !== 'txn-new'));

      expect(await ask({ amountCents: 5_001 })).toEqual({ ok: true, pendingApproval: true });
      expect(debitCalls[1]).toMatchObject({ p_requires_approval: true });
    });

    it('follows this child’s own rule, including a threshold of zero', async () => {
      db.seed('wallet_rules', [{ family_id: FAMILY, child_wallet_id: 'wallet-a', require_approval_over_cents: 0 }]);

      expect(await ask({ amountCents: 1 })).toEqual({ ok: true, pendingApproval: true });
      expect(debitCalls[0]).toMatchObject({ p_requires_approval: true });
    });

    it('ignores a rule written for another child or by another family', async () => {
      db.seed('wallet_rules', [
        { family_id: FAMILY, child_wallet_id: 'wallet-b', require_approval_over_cents: 0 },
        { family_id: 'family-2', child_wallet_id: 'wallet-a', require_approval_over_cents: 0 },
      ]);

      expect(await ask({ amountCents: 1_200 })).toEqual({ ok: true });
      expect(debitCalls[0]).toMatchObject({ p_requires_approval: false });
    });

    it('a Trust answer short of "allow" sends even a parent’s small spend for review', async () => {
      harness.decision = { effect: 'require_approval', reason: 'Needs a second parent.', basis: 'policy' };

      expect(await ask({ amountCents: 100 })).toEqual({ ok: true, pendingApproval: true });
      expect(debitCalls[0]).toMatchObject({
        p_requires_approval: true,
        p_metadata: { requested_by_member: 'member-self', trust_basis: 'policy', trust_effect: 'require_approval' },
      });
    });

    it.each(NON_MANAGERS)('a %s’s request, however small, is sent as held and files an approval', async (role) => {
      harness.role = role;

      expect(await ask({ amountCents: 100 })).toEqual({ ok: true, pendingApproval: true });
      expect(debitCalls).toHaveLength(1);
      expect(debitCalls[0]).toMatchObject({ p_requires_approval: true, p_actor_id: 'user-self' });
      expect((harness.evaluateTrust.mock.calls[0] as [unknown, string, { actor: unknown }])[2].actor)
        .toEqual({ kind: 'member', id: 'member-self', role });
      expect(approvals()).toHaveLength(1);
    });

    it('a role default "no" is not a refusal: a child can still ask', async () => {
      harness.role = 'child';
      harness.decision = { effect: 'deny', reason: 'Children cannot spend.', basis: 'role_default' };

      expect(await ask()).toEqual({ ok: true, pendingApproval: true });
      expect(debitCalls[0]).toMatchObject({ p_requires_approval: true });
    });
  });

  describe('refusals', () => {
    it.each(['deny_grant', 'policy'])('an explicit denial (%s) refuses before any money moves', async (basis) => {
      harness.decision = { ...DENY_POLICY, basis };

      expect(await ask()).toEqual({ ok: false, error: householdPolicyBlocked(t, harness.decision as never) });
      expect(debitCalls).toHaveLength(0);
      expect(approvals()).toHaveLength(0);
      expect(harness.revalidatePath).not.toHaveBeenCalled();
    });

    it.each([0, -500, 0.9, Number.NaN, Number.POSITIVE_INFINITY])('refuses an amount of %s before reading anything', async (amountCents) => {
      expect(await ask({ amountCents })).toEqual({ ok: false, error: t('actions.enterAnAmountGreaterThan') });
      expect(db.log).toHaveLength(0);
      expect(debitCalls).toHaveLength(0);
    });

    it.each([
      ['another family’s wallet', 'wallet-x'],
      ['a wallet that does not exist', 'wallet-missing'],
    ])('%s is not found, and nothing is read from its ledger or sent', async (_label, childWalletId) => {
      expect(await ask({ childWalletId })).toEqual({ ok: false, error: t('actions.thatWalletWasNotFound') });
      expect(db.log.map((entry) => entry.table)).not.toContain('wallet_transactions');
      expect(harness.evaluateTrust).not.toHaveBeenCalled();
      expect(debitCalls).toHaveLength(0);
    });

    it('asks for no more than the completed Spend balance: 100.00 fits, 100.01 does not', async () => {
      expect(await ask({ amountCents: 10_001 })).toEqual({ ok: false, error: t('actions.onlyAmountAvailableInSpend', { amount: '100.00' }) });
      expect(debitCalls).toHaveLength(0);
      expect(harness.evaluateTrust).not.toHaveBeenCalled();

      expect(await ask({ amountCents: 10_000 })).toEqual({ ok: true, pendingApproval: true });
      expect(debitCalls).toHaveLength(1);
    });

    it('a wallet read failure is a failure in words, with nothing sent', async () => {
      override('child_wallets', 'maybeSingle', { error: PG_ERROR });

      expect(await ask()).toEqual({ ok: false, error: describeActionError(PG_ERROR, t('actions.couldNotLoadThatWallet')) });
      expect(debitCalls).toHaveLength(0);
    });

    it('a rule read failure is a failure in words, not the default threshold', async () => {
      override('wallet_rules', 'maybeSingle', { error: PG_ERROR });

      expect(await ask()).toEqual({ ok: false, error: describeActionError(PG_ERROR, t('actions.couldNotLoadTheWallet3')) });
      expect(debitCalls).toHaveLength(0);
    });

    it('a Spend bucket that cannot be read stops the request before Trust or the RPC', async () => {
      override('wallet_buckets', 'maybeSingle', { error: PG_ERROR });

      const result = await ask();

      expect(result).toEqual({ ok: false, error: await balanceSays() });
      expect(result.error).not.toBe(t('actions.onlyAmountAvailableInSpend', { amount: '0.00' }));
      expect(harness.evaluateTrust).not.toHaveBeenCalled();
      expect(debitCalls).toHaveLength(0);
    });

    it('a missing Spend bucket stops the request before Trust or the RPC', async () => {
      db.replace('wallet_buckets', db.table('wallet_buckets').filter((bucket) => bucket.id !== 'a-spend'));

      const result = await ask();

      expect(result).toEqual({ ok: false, error: await balanceSays() });
      expect(result.error).not.toBe(t('actions.onlyAmountAvailableInSpend', { amount: '0.00' }));
      expect(harness.evaluateTrust).not.toHaveBeenCalled();
      expect(debitCalls).toHaveLength(0);
    });

    it('a ledger read failure stops the request rather than treating the balance as zero or whole', async () => {
      const from = db.from.bind(db);
      (db as unknown as { from: (name: string) => unknown }).from = (name: string) => {
        const builder = from(name) as unknown as Record<string, unknown>;
        if (name === 'wallet_transactions') {
          builder.range = () => ({ then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: PG_ERROR, count: null, status: 500, statusText: 'Error' }).then(resolve) });
        }
        return builder;
      };

      const result = await ask({ amountCents: 100 });

      expect(result).toEqual({ ok: false, error: await balanceSays() });
      expect(result.error).not.toBe(t('actions.onlyAmountAvailableInSpend', { amount: '0.00' }));
      expect(debitCalls).toHaveLength(0);
    });
  });

  describe('when the debit RPC refuses or fails', () => {
    it.each([
      [{ ok: false, reason: 'forbidden' }],
      [{ ok: false, reason: 'insufficient_funds', available: 300 }],
      [{ ok: false, reason: 'spend_bucket_missing' }],
      [{ ok: false, reason: 'wallet_not_found' }],
    ])('passes on the wrapper’s answer to %j, files no approval and refreshes nothing', async (reply) => {
      harness.role = 'child';
      harness.debit = () => reply;

      expect(await ask()).toEqual({ ok: false, error: await wrapperSays('wallet_debit_spend_bucket', () => reply) });
      expect(debitCalls).toHaveLength(1);
      expect(approvals()).toHaveLength(0);
      expect(harness.revalidatePath).not.toHaveBeenCalled();
    });

    it('a thrown RPC error is a failure too, and the database’s own text is not passed on', async () => {
      harness.debit = () => { throw new Error('deadlock detected'); };

      const result = await ask();

      expect(result).toEqual({ ok: false, error: await wrapperSays('wallet_debit_spend_bucket', () => { throw new Error('deadlock detected'); }) });
      expect(result.error).not.toContain('deadlock');
      expect(harness.revalidatePath).not.toHaveBeenCalled();
    });
  });

  describe('when the approval row cannot be filed', () => {
    const APPROVAL_DENIED = { code: '42501', message: 'new row violates row-level security policy for table "parent_approvals"', details: null, hint: null };

    it('cancels the held debit it just posted and reports the failure', async () => {
      override('parent_approvals', 'insert', { error: APPROVAL_DENIED });

      const result = await ask({ amountCents: 6_000 });

      expect(result).toEqual({ ok: false, error: describeActionError(APPROVAL_DENIED, t('actions.couldNotCreateTheSpend')) });
      expect(txn('txn-new')).toMatchObject({ status: 'cancelled' });
      expect(approvals()).toHaveLength(0);
      expect(harness.revalidatePath).not.toHaveBeenCalled();
      expect(console.error).not.toHaveBeenCalledWith(expect.stringContaining('hold may be stranded'), expect.anything());
    });

    it('does not cancel a debit someone else already resolved, and says the hold may be stranded', async () => {
      override('parent_approvals', 'insert', { error: APPROVAL_DENIED }, () => { txn('txn-new').status = 'completed'; });

      const result = await ask({ amountCents: 6_000 });

      expect(result.ok).toBe(false);
      expect(txn('txn-new')).toMatchObject({ status: 'completed' });
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('hold may be stranded'),
        expect.objectContaining({ txnId: 'txn-new', familyId: FAMILY, error: 'no rows updated' }),
      );
    });

    it('leaves every other row alone', async () => {
      override('parent_approvals', 'insert', { error: APPROVAL_DENIED });

      await ask({ amountCents: 6_000 });

      expect(db.table('wallet_transactions').filter((row) => row.status === 'cancelled').map((row) => row.id)).toEqual(['txn-new']);
      expect(txn('t3')).toMatchObject({ status: 'requires_parent_approval' });
    });

    it('with no transaction id to point at, the approval’s ref is empty and there is nothing to cancel', async () => {
      harness.debit = () => ({ ok: true });
      const inserted: Row[] = [];
      let rollbacks = 0;
      const from = db.from.bind(db);
      (db as unknown as { from: (name: string) => unknown }).from = (name: string) => {
        const builder = from(name) as unknown as Record<string, unknown>;
        if (name === 'parent_approvals') {
          builder.insert = (row: Row) => { inserted.push(row); return { then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: APPROVAL_DENIED }).then(resolve) }; };
        }
        if (name === 'wallet_transactions') {
          const update = (builder.update as (patch: Row) => unknown).bind(builder);
          builder.update = (patch: Row) => { rollbacks += 1; return update(patch); };
        }
        return builder;
      };

      expect((await ask({ amountCents: 6_000 })).ok).toBe(false);
      expect(inserted).toEqual([expect.objectContaining({ ref_id: null })]);
      expect(rollbacks).toBe(0);
    });
  });
});

describe('decideSpendRequestAction (ACTION-3DB849535F18)', () => {
  beforeEach(() => {
    db.seed('wallet_transactions', [
      { id: 'txn-held', family_id: FAMILY, child_wallet_id: 'wallet-a', bucket_id: 'a-spend', direction: 'debit', amount_cents: 1_200, status: 'requires_parent_approval' },
      { id: 'txn-x', family_id: 'family-2', child_wallet_id: 'wallet-x', bucket_id: 'x-spend', direction: 'debit', amount_cents: 700, status: 'requires_parent_approval' },
    ]);
    db.seed('parent_approvals', [
      { id: 'appr-1', family_id: FAMILY, status: 'pending', ref_type: 'wallet_transactions', ref_id: 'txn-held', amount_cents: 1_200 },
      { id: 'appr-done', family_id: FAMILY, status: 'approved', ref_type: 'wallet_transactions', ref_id: 'txn-held', amount_cents: 1_200 },
      { id: 'appr-gift', family_id: FAMILY, status: 'pending', ref_type: 'gift_payments', ref_id: 'gift-1', amount_cents: 500 },
      { id: 'appr-noref', family_id: FAMILY, status: 'pending', ref_type: 'wallet_transactions', ref_id: null, amount_cents: 500 },
      { id: 'appr-cross', family_id: FAMILY, status: 'pending', ref_type: 'wallet_transactions', ref_id: 'txn-x', amount_cents: 700 },
      { id: 'appr-gone', family_id: FAMILY, status: 'pending', ref_type: 'wallet_transactions', ref_id: 'txn-missing', amount_cents: 700 },
      { id: 'appr-x', family_id: 'family-2', status: 'pending', ref_type: 'wallet_transactions', ref_id: 'txn-x', amount_cents: 700 },
    ]);
  });

  const decide = (over: Partial<Parameters<typeof decideSpendRequestAction>[0]> = {}) =>
    decideSpendRequestAction({ approvalId: 'appr-1', decision: 'approved', ...over });

  it('a parent’s approval goes to the RPC once, as the user, and refreshes the wallet', async () => {
    expect(await decide()).toEqual({ ok: true });

    expect(decideCalls).toEqual([{ p_family_id: FAMILY, p_approval_id: 'appr-1', p_decision: 'approved', p_note: null, p_actor_id: 'user-self' }]);
    expect(harness.revalidatePath).toHaveBeenCalledTimes(1);
    expect(harness.revalidatePath).toHaveBeenCalledWith('/wallet');
  });

  it('checks the approver with the Trust Engine: finances, approve, the held amount', async () => {
    await decide();

    expect(harness.evaluateTrust).toHaveBeenCalledTimes(1);
    const [client, family, request] = harness.evaluateTrust.mock.calls[0] as [unknown, string, Record<string, unknown>];
    expect(client).toBe(db);
    expect(family).toBe(FAMILY);
    expect(request).toMatchObject({
      actor: { kind: 'member', id: 'member-self', role: 'parent' },
      domain: 'finances', capability: 'approve', context: { amountCents: 1_200 }, openApproval: false,
    });
  });

  it('a rejection carries its note, and needs no Trust check', async () => {
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

    expect(await decide()).toEqual({ ok: false, error: t('actions.onlyAParentGuardianCan17') });
    expect(db.log).toHaveLength(0);
    expect(decideCalls).toHaveLength(0);
    expect(harness.revalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    ['another family’s request', 'appr-x', 'actions.requestNotFound'],
    ['a request that does not exist', 'appr-missing', 'actions.requestNotFound'],
    ['a request already decided', 'appr-done', 'actions.thisRequestWasAlreadyDecided'],
    ['a request about something other than a wallet transaction', 'appr-gift', 'actions.requestIsMissingItsTransaction'],
    ['a request with no transaction', 'appr-noref', 'actions.requestIsMissingItsTransaction'],
  ])('%s is refused before the transaction is read', async (_label, approvalId, key) => {
    expect(await decide({ approvalId })).toEqual({ ok: false, error: t(key) });
    expect(db.log.map((entry) => entry.table)).toEqual(['parent_approvals']);
    expect(harness.evaluateTrust).not.toHaveBeenCalled();
    expect(decideCalls).toHaveLength(0);
  });

  it.each([
    ['held in another family', 'appr-cross'],
    ['that no longer exists', 'appr-gone'],
  ])('a request whose transaction is %s is refused, and nothing is decided', async (_label, approvalId) => {
    expect(await decide({ approvalId })).toEqual({ ok: false, error: t('actions.transactionNotFound') });
    expect(decideCalls).toHaveLength(0);
    expect(txn('txn-x')).toMatchObject({ status: 'requires_parent_approval' });
  });

  it('a request read failure is a failure in words', async () => {
    override('parent_approvals', 'maybeSingle', { error: PG_ERROR });

    expect(await decide()).toEqual({ ok: false, error: describeActionError(PG_ERROR, t('actions.couldNotLoadThatSpend')) });
    expect(decideCalls).toHaveLength(0);
  });

  it('a transaction read failure is a failure in words', async () => {
    override('wallet_transactions', 'maybeSingle', { error: PG_ERROR });

    expect(await decide()).toEqual({ ok: false, error: describeActionError(PG_ERROR, t('actions.couldNotLoadTheSpend')) });
    expect(decideCalls).toHaveLength(0);
  });

  it('a Trust denial of the approver stops an approval before the RPC', async () => {
    harness.decision = DENY_POLICY;

    expect(await decide()).toEqual({ ok: false, error: householdPolicyBlocked(t, DENY_POLICY as never) });
    expect(decideCalls).toHaveLength(0);
    expect(harness.revalidatePath).not.toHaveBeenCalled();
  });

  it('a Trust requirement for another approval stops settlement before the RPC', async () => {
    const decision = { effect: 'require_approval', reason: 'Needs a second parent.', basis: 'policy' } as const;
    harness.decision = decision;

    expect(await decide()).toEqual({ ok: false, error: householdPolicyBlocked(t, decision) });
    expect(decideCalls).toHaveLength(0);
    expect(harness.revalidatePath).not.toHaveBeenCalled();
  });

  it('a Trust denial does not stop a rejection, which moves no money', async () => {
    harness.decision = DENY_POLICY;

    expect(await decide({ decision: 'rejected' })).toEqual({ ok: true });
    expect(decideCalls[0]).toMatchObject({ p_decision: 'rejected' });
  });

  it.each([
    [{ ok: false, reason: 'insufficient_funds', available: 400 }],
    [{ ok: false, reason: 'already_processed' }],
    [{ ok: false, reason: 'forbidden' }],
    [{ ok: false, reason: 'not_found' }],
    [{ ok: false }],
  ])('passes on the wrapper’s answer to %j and does not claim success', async (reply) => {
    harness.decide = () => reply;

    expect(await decide()).toEqual({ ok: false, error: await wrapperSays('wallet_decide_spend', () => reply) });
    expect(decideCalls).toHaveLength(1);
    expect(harness.revalidatePath).not.toHaveBeenCalled();
  });

  it('a thrown RPC error is a failure, without the database’s own text', async () => {
    harness.decide = () => { throw new Error('deadlock detected'); };

    const result = await decide();

    expect(result.ok).toBe(false);
    expect(result.error).toBe(await wrapperSays('wallet_decide_spend', () => { throw new Error('deadlock detected'); }));
    expect(result.error).not.toContain('deadlock');
    expect(harness.revalidatePath).not.toHaveBeenCalled();
  });
});
