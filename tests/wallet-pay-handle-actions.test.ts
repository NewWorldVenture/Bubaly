import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

/**
 * claimPayHandleAction and releasePayHandleAction (app/(app)/wallet/actions.ts),
 * run as code. `wallet-pay-handle.test.ts` covers the pure helpers in
 * lib/wallet/pay-handle.ts; nothing ran either action. This drives both
 * against an in-memory store that enforces `pay_handles.handle` as unique, the
 * way `idx_pay_handles_handle` (00950) does, and asserts what each writes and
 * answers.
 *
 * Finding: MAIN-F-F07. Register B: ACTION-08F2999FFC3A (claimPayHandleAction),
 * ACTION-AB41E531B9BB (releasePayHandleAction).
 */

const FAMILY = 'family-1';
const harness = vi.hoisted(() => ({
  db: null as unknown,
  role: 'parent',
  revalidatePath: null as unknown as Mock<(...args: unknown[]) => unknown>,
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

const { claimPayHandleAction, releasePayHandleAction } = await import('@/app/(app)/wallet/actions');
const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
const { describeActionError } = await import('@/lib/supabase/errors');
const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);

const PG_ERROR = { code: '57014', message: 'canceling statement due to statement timeout', details: null, hint: null };
const NON_MANAGERS = ['teen', 'child', 'caregiver', 'guest'];
const TAKEN = t('actions.thatPayIdIsAlready');

let db: InMemorySupabase;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase({ uniques: { pay_handles: [['handle']] } });
  harness.db = db;
  harness.role = 'parent';
  harness.revalidatePath.mockClear();
  db.seed('child_wallets', [
    { id: 'wallet-a', family_id: FAMILY, member_id: 'member-a' },
    { id: 'wallet-x', family_id: 'family-2', member_id: 'member-x' },
  ]);
  db.seed('pay_handles', [
    { id: 'handle-own', family_id: FAMILY, child_wallet_id: 'wallet-a', handle: 'maya', is_active: true, created_by: 'user-parent' },
    { id: 'handle-own-2', family_id: FAMILY, child_wallet_id: null, handle: 'rivera_family', is_active: true, created_by: 'user-parent' },
    { id: 'handle-elsewhere', family_id: 'family-2', child_wallet_id: 'wallet-x', handle: 'sam', is_active: true, created_by: 'user-other' },
  ]);
});

/** Replace one table's builder method so that call answers `reply`. */
function override(table: string, method: 'insert' | 'maybeSingle' | 'delete', reply: Record<string, unknown>) {
  const from = db.from.bind(db);
  (db as unknown as { from: (name: string) => unknown }).from = (name: string) => {
    const builder = from(name) as unknown as Record<string, unknown>;
    if (name !== table) return builder;
    const answer = { data: null, count: null, status: 500, statusText: 'Error', ...reply };
    const settle = { then: (resolve: (v: unknown) => unknown) => Promise.resolve(answer).then(resolve) };
    if (method === 'insert') builder.insert = () => settle;
    if (method === 'maybeSingle') builder.maybeSingle = async () => answer;
    if (method === 'delete') builder.delete = () => { const chain: Record<string, unknown> = { eq: () => chain, select: () => settle }; return chain; };
    return builder;
  };
}

const handles = () => db.table('pay_handles');
const byId = (id: string) => handles().find((h) => h.id === id);
const audit = () => db.table('wallet_audit_logs');

describe('claimPayHandleAction (ACTION-08F2999FFC3A)', () => {
  it('claims a family-wide Pay-ID, normalized, as the parent, and records it', async () => {
    expect(await claimPayHandleAction({ childWalletId: null, handle: '  @Grandma_Fund ' })).toEqual({ ok: true });

    const row = handles().find((h) => h.handle === 'grandma_fund');
    expect(row).toMatchObject({ family_id: FAMILY, child_wallet_id: null, is_active: true, created_by: 'user-parent' });
    expect(audit()).toHaveLength(1);
    expect(audit()[0]).toMatchObject({ family_id: FAMILY, actor_user_id: 'user-parent', action: 'pay_handle_claimed', entity_type: 'pay_handles', detail: 'grandma_fund' });
    expect(harness.revalidatePath).toHaveBeenCalledWith('/wallet/gift');
  });

  it('claims one for the family’s own child wallet', async () => {
    expect(await claimPayHandleAction({ childWalletId: 'wallet-a', handle: 'maya_bike' })).toEqual({ ok: true });
    expect(handles().find((h) => h.handle === 'maya_bike')).toMatchObject({ family_id: FAMILY, child_wallet_id: 'wallet-a' });
  });

  it('lets an adult manager claim one too', async () => {
    harness.role = 'adult';
    expect(await claimPayHandleAction({ childWalletId: null, handle: 'adult_claim' })).toEqual({ ok: true });
  });

  it.each(NON_MANAGERS)('refuses a %s before reading or writing anything', async (role) => {
    harness.role = role;
    expect(await claimPayHandleAction({ childWalletId: null, handle: 'kid_claim' })).toEqual({ ok: false, error: t('actions.onlyAParentGuardianCan15') });
    expect(db.log).toHaveLength(0);
    expect(handles()).toHaveLength(3);
  });

  it.each(['', 'ab', '!!', 'a'.repeat(21), 'admin', 'Pay'])('refuses the handle %j before reading or writing anything', async (handle) => {
    const result = await claimPayHandleAction({ childWalletId: null, handle });

    // The refusal's wording comes from lib/wallet/pay-handle's handleError; it
    // is deliberately not pinned here (see the PR: it is English in every locale).
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(db.log).toHaveLength(0);
    expect(handles()).toHaveLength(3);
    expect(harness.revalidatePath).not.toHaveBeenCalled();
  });

  it.each([
    ['another family’s child wallet', 'wallet-x'],
    ['a child wallet that does not exist', 'wallet-missing'],
  ])('refuses a Pay-ID for %s, before checking the handle', async (_, childWalletId) => {
    expect(await claimPayHandleAction({ childWalletId, handle: 'fresh_name' })).toEqual({ ok: false, error: t('actions.childWalletNotFound') });
    expect(db.log.map((entry) => entry.table)).toEqual(['child_wallets']);
    expect(handles()).toHaveLength(3);
  });

  it('fails closed when the child wallet cannot be read', async () => {
    override('child_wallets', 'maybeSingle', { error: PG_ERROR });
    expect(await claimPayHandleAction({ childWalletId: 'wallet-a', handle: 'fresh_name' })).toEqual({ ok: false, error: describeActionError(PG_ERROR, t('actions.couldNotLoadThatChild')) });
    expect(handles()).toHaveLength(3);
  });

  it('refuses a handle another family holds before attempting any write, and leaves theirs alone', async () => {
    expect(await claimPayHandleAction({ childWalletId: null, handle: 'Sam' })).toEqual({ ok: false, error: TAKEN });
    // One read of pay_handles (the availability check) and nothing after it:
    // the refusal does not lean on the unique index to catch the write.
    expect(db.log.map((entry) => entry.table)).toEqual(['pay_handles']);
    expect(byId('handle-elsewhere')).toMatchObject({ family_id: 'family-2', handle: 'sam', child_wallet_id: 'wallet-x' });
    expect(handles()).toHaveLength(3);
    expect(audit()).toHaveLength(0);
  });

  it('refuses a second claim of a handle the family already holds (the unique index answers)', async () => {
    expect(await claimPayHandleAction({ childWalletId: null, handle: 'maya' })).toEqual({ ok: false, error: TAKEN });
    expect(handles().filter((h) => h.handle === 'maya')).toHaveLength(1);
    expect(harness.revalidatePath).not.toHaveBeenCalled();
  });

  it('fails closed when availability cannot be checked', async () => {
    override('pay_handles', 'maybeSingle', { error: PG_ERROR });
    expect(await claimPayHandleAction({ childWalletId: null, handle: 'fresh_name' })).toEqual({ ok: false, error: describeActionError(PG_ERROR, t('actions.couldNotCheckPayId')) });
    expect(handles()).toHaveLength(3);
  });

  describe('renaming (with an id)', () => {
    it('renames the family’s own Pay-ID in place, and may move it to another of its wallets', async () => {
      expect(await claimPayHandleAction({ id: 'handle-own-2', childWalletId: 'wallet-a', handle: 'riveras' })).toEqual({ ok: true });
      expect(byId('handle-own-2')).toMatchObject({ family_id: FAMILY, handle: 'riveras', child_wallet_id: 'wallet-a', is_active: true });
      expect(handles()).toHaveLength(3);
      expect(harness.revalidatePath).toHaveBeenCalledWith('/wallet/gift');
    });

    it('keeps a Pay-ID’s own name when it is saved unchanged', async () => {
      expect(await claimPayHandleAction({ id: 'handle-own', childWalletId: 'wallet-a', handle: 'maya' })).toEqual({ ok: true });
      expect(byId('handle-own')).toMatchObject({ handle: 'maya' });
    });

    it('refuses renaming onto another of the family’s own Pay-IDs', async () => {
      expect(await claimPayHandleAction({ id: 'handle-own-2', childWalletId: null, handle: 'maya' })).toEqual({ ok: false, error: TAKEN });
      expect(byId('handle-own-2')).toMatchObject({ handle: 'rivera_family' });
    });

    it('does not rename another family’s Pay-ID', async () => {
      expect(await claimPayHandleAction({ id: 'handle-elsewhere', childWalletId: null, handle: 'stolen_name' })).toEqual({ ok: false, error: t('actions.couldNotClaimThatPay') });
      expect(byId('handle-elsewhere')).toMatchObject({ family_id: 'family-2', handle: 'sam', child_wallet_id: 'wallet-x' });
      expect(audit()).toHaveLength(0);
      expect(harness.revalidatePath).not.toHaveBeenCalled();
    });
  });

  it('reports a refused insert as a failure, in words, with no audit row and no refresh', async () => {
    const error = { code: '42501', message: 'new row violates row-level security policy for table "pay_handles"', details: null, hint: null };
    override('pay_handles', 'insert', { error, status: 403 });

    const result = await claimPayHandleAction({ childWalletId: null, handle: 'fresh_name' });

    expect(result).toEqual({ ok: false, error: describeActionError(error, t('actions.couldNotClaimThatPay')) });
    expect(result.error).not.toContain('row-level security');
    expect(audit()).toHaveLength(0);
    expect(harness.revalidatePath).not.toHaveBeenCalled();
  });
});

describe('releasePayHandleAction (ACTION-AB41E531B9BB)', () => {
  it('releases the family’s Pay-ID, so it no longer resolves', async () => {
    expect(await releasePayHandleAction({ id: 'handle-own' })).toEqual({ ok: true });
    expect(byId('handle-own')).toBeUndefined();
    expect(handles()).toHaveLength(2);
    expect(harness.revalidatePath).toHaveBeenCalledWith('/wallet/gift');
  });

  it.each(NON_MANAGERS)('refuses a %s before touching anything', async (role) => {
    harness.role = role;
    expect(await releasePayHandleAction({ id: 'handle-own' })).toEqual({ ok: false, error: t('actions.onlyAParentGuardianCan16') });
    expect(db.log).toHaveLength(0);
    expect(byId('handle-own')).toBeDefined();
  });

  it.each([
    ['another family’s Pay-ID', 'handle-elsewhere'],
    ['a Pay-ID that does not exist', 'handle-missing'],
  ])('does not claim to release %s', async (_, id) => {
    expect(await releasePayHandleAction({ id })).toEqual({ ok: false, error: t('actions.couldNotReleaseThatPay') });
    expect(handles()).toHaveLength(3);
    expect(harness.revalidatePath).not.toHaveBeenCalled();
  });

  it('reports a failed delete as a failure, in words, and keeps the Pay-ID', async () => {
    override('pay_handles', 'delete', { error: PG_ERROR });

    const result = await releasePayHandleAction({ id: 'handle-own' });

    expect(result).toEqual({ ok: false, error: describeActionError(PG_ERROR, t('actions.couldNotReleaseThatPay')) });
    expect(byId('handle-own')).toBeDefined();
    expect(harness.revalidatePath).not.toHaveBeenCalled();
  });
});
