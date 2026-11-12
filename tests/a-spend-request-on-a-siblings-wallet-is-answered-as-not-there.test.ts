import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

/**
 * requestSpendAction (app/(app)/wallet/actions.ts) bound the wallet it was given
 * to the FAMILY only, then read that wallet's Spend balance and printed it when
 * the request did not fit. So a teen, a child, a caregiver or a kid login who
 * named a sibling's wallet and asked for more than any child holds was told
 * "Only 47.25 available in Spend." — the sibling's exact balance, for every
 * wallet in the household, with nothing filed for a parent to see. The debit
 * behind it never lands (wallet_debit_spend_bucket, 0342, is a manager's), so
 * the balance was the only thing such a request ever got.
 *
 * A child's money is read by a parent or adult and by that child (the held
 * 0515; lib/wallet/own-wallets.ts holds the same rule in the app). The child
 * wallet page and the child coach answer a sibling's wallet as one that is not
 * there; this action now answers it the same way, before it reads a balance.
 *
 * Finding N1 (child-money-scope). The RPC is synthetic; nothing here
 * establishes row-level security or the lock.
 */

const FAMILY = 'family-1';
const harness = vi.hoisted(() => ({
  db: null as unknown,
  role: 'parent',
  evaluateTrust: null as unknown as Mock<(...args: unknown[]) => unknown>,
}));

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
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
  harness.evaluateTrust = v.fn(async () => ({ decision: { effect: 'allow', reason: 'Allowed.', basis: 'role_default' } }));
  return { ...(await importOriginal<typeof import('@/lib/trust/server')>()), evaluateTrust: (...args: unknown[]) => harness.evaluateTrust(...args) };
});

const { requestSpendAction } = await import('@/app/(app)/wallet/actions');
const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);

/** Children, teens and caregivers, and a kid login, which signs in with a child's role. */
const NOT_MANAGERS = ['teen', 'child', 'caregiver'];
const MORE_THAN_ANY_CHILD_HOLDS = 1_000_000_000;

let db: InMemorySupabase;
let debitCalls: Record<string, unknown>[];

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  debitCalls = [];
  db = createInMemorySupabase({
    rpc: {
      wallet_debit_spend_bucket: (args, store) => {
        debitCalls.push(args);
        (store as InMemorySupabase).table('wallet_transactions').push({
          id: 'txn-new', family_id: args.p_family_id, child_wallet_id: args.p_child_wallet_id, direction: 'debit',
          amount_cents: args.p_amount, status: args.p_requires_approval ? 'requires_parent_approval' : 'completed',
        });
        return { ok: true, transaction_id: 'txn-new' };
      },
    },
  });
  harness.db = db;
  harness.role = 'parent';
  harness.evaluateTrust.mockClear();
  // wallet-own is the caller's; wallet-sib is a sibling's, holding 47.25 in Spend.
  db.seed('child_wallets', [
    { id: 'wallet-own', family_id: FAMILY, member_id: 'member-self' },
    { id: 'wallet-sib', family_id: FAMILY, member_id: 'member-sibling' },
  ]);
  db.seed('wallet_buckets', [
    { id: 'own-spend', family_id: FAMILY, child_wallet_id: 'wallet-own', kind: 'spend' },
    { id: 'sib-spend', family_id: FAMILY, child_wallet_id: 'wallet-sib', kind: 'spend' },
  ]);
  db.seed('wallet_transactions', [
    { id: 't-own', family_id: FAMILY, child_wallet_id: 'wallet-own', bucket_id: 'own-spend', direction: 'credit', amount_cents: 1_200, status: 'completed' },
    { id: 't-sib', family_id: FAMILY, child_wallet_id: 'wallet-sib', bucket_id: 'sib-spend', direction: 'credit', amount_cents: 4_725, status: 'completed' },
  ]);
});

const ask = (childWalletId: string, amountCents: number) =>
  requestSpendAction({ childWalletId, amountCents, description: 'Anything' });
const tablesRead = () => db.log.map((entry) => entry.table);

describe('a spend request on a sibling\'s wallet is answered as not there', () => {
  it.each(NOT_MANAGERS)('a %s naming a sibling\'s wallet is told it is not there, never its balance', async (role) => {
    harness.role = role;

    const result = await ask('wallet-sib', MORE_THAN_ANY_CHILD_HOLDS);

    expect(result).toEqual({ ok: false, error: t('actions.thatWalletWasNotFound') });
    expect(result.error).not.toContain('47.25');
  });

  it.each(NOT_MANAGERS)('a %s\'s request on a sibling\'s wallet reads no balance, asks no one and files nothing', async (role) => {
    harness.role = role;

    await ask('wallet-sib', 100);

    expect(tablesRead()).not.toContain('wallet_buckets');
    expect(tablesRead()).not.toContain('wallet_transactions');
    expect(harness.evaluateTrust).not.toHaveBeenCalled();
    expect(debitCalls).toHaveLength(0);
    expect(db.table('parent_approvals')).toHaveLength(0);
  });

  it.each(NOT_MANAGERS)('a %s still asks from their own wallet, as a held request', async (role) => {
    harness.role = role;

    expect(await ask('wallet-own', 100)).toEqual({ ok: true, pendingApproval: true });
    expect(debitCalls).toEqual([expect.objectContaining({ p_child_wallet_id: 'wallet-own', p_requires_approval: true })]);
  });

  it.each(NOT_MANAGERS)('a %s asking too much of their own wallet is told their own balance', async (role) => {
    harness.role = role;

    expect(await ask('wallet-own', MORE_THAN_ANY_CHILD_HOLDS)).toEqual({ ok: false, error: t('actions.onlyAmountAvailableInSpend', { amount: '12.00' }) });
  });

  it.each(['parent', 'adult'])('a %s still moves money from any child\'s wallet in the family', async (role) => {
    harness.role = role;

    expect(await ask('wallet-sib', MORE_THAN_ANY_CHILD_HOLDS)).toEqual({ ok: false, error: t('actions.onlyAmountAvailableInSpend', { amount: '47.25' }) });
    expect(await ask('wallet-sib', 1_200)).toEqual({ ok: true });
    expect(debitCalls).toEqual([expect.objectContaining({ p_child_wallet_id: 'wallet-sib', p_requires_approval: false })]);
  });
});
