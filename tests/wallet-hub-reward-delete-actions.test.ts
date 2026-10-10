import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addRewardAction, deleteWalletRowAction } from '@/app/(app)/wallet/hub-actions';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

// MAIN-F-F07: ACTION-5D3801997423 / ACTION-ABA3017332BE.
// These exports manage manually tracked wallet records. Migration 0113 and
// docs/wallet-hub-supabase.md allow family-member writes to cards/passes/rewards;
// household accounts/transactions have the separate manager guard from 0267.
// The unchanged fake proves action behavior, not RLS/schema constraints or UI
// refresh. wallet-hub.tsx owns table refresh after a successful action result.
const mocks = vi.hoisted(() => ({ createServer: vi.fn(), requireUserContext: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
// The step-up gate on the household-money tables has its own test
// (the-wallet-hub-asks-for-the-code-before-money.test.ts); this fake client has
// no auth.mfa, so here the session is one that may change money.
vi.mock('@/lib/auth/require-aal2', () => ({ aal2Verdict: async () => ({ action: 'allow' }) }));

const FAMILY = 'session-family';
const USER = 'session-user';
const OTHER = { id: 'foreign-row', family_id: 'foreign-family', name: 'Foreign record' };
const TARGET = { id: 'target-row', family_id: FAMILY, name: 'Target record' };
const KEEP = { id: 'keep-row', family_id: FAMILY, name: 'Keep record' };
const TABLES = ['wallet_cards', 'wallet_passes', 'wallet_rewards', 'financial_accounts', 'transactions'];
const NON_MANAGERS = ['teen', 'child', 'caregiver', 'guest'];
const REWARD_DEFAULTS = { kind: 'points', unit: 'points', balance: 0, value_cents: 0, program: null };
const PERMISSION_ERROR = "You don't have permission to do that. Ask a family admin if you think this is a mistake.";
const DATABASE_FAILURES = [
  { code: 'XX000', expected: null },
  { code: '', expected: null },
  { code: '42501', expected: PERMISSION_ERROR },
  { code: '23514', expected: 'Some required information is missing or invalid. Please review and try again.' },
];
let db: InMemorySupabase;

function asRole(role: string) {
  mocks.requireUserContext.mockResolvedValue({
    user: { id: USER },
    active: { familyId: FAMILY, role, member: { id: 'session-member' }, family: { id: FAMILY, timezone: 'UTC' } },
  });
}

function failWrite(table: string, code: string) {
  const from = db.from.bind(db);
  vi.spyOn(db, 'from').mockImplementation((name) => {
    const query = from(name);
    if (name === table) {
      // Reject at execution, before the in-memory write changes any rows.
      const reply = { data: null, error: { code, message: 'private relation and constraint detail', details: null, hint: null },
        count: null, status: 400, statusText: 'Bad Request' };
      vi.spyOn(query, 'then').mockImplementation((resolve, reject) => Promise.resolve(reply).then(resolve, reject));
      // The transactions branch reads its reply through `.maybeSingle()` (lib/services/finances).
      vi.spyOn(query, 'maybeSingle').mockImplementation(() => Promise.resolve(reply) as never);
    }
    return query;
  });
}

async function expectReward(payload: Row) {
  expect(db.log).toEqual([{ table: 'wallet_rewards' }]);
  expect(mocks.createServer).toHaveBeenCalledTimes(1);
  const { data, error } = await db.from('wallet_rewards').select('*').eq('family_id', FAMILY).single();
  expect(error).toBeNull();
  expect(data).toEqual({ ...payload, family_id: FAMILY, created_by: USER,
    id: expect.any(String), created_at: expect.any(String), updated_at: expect.any(String) });
  expect(db.table('wallet_rewards')).toHaveLength(2);
  expect(db.table('wallet_rewards').find((row) => row.id === OTHER.id)).toEqual(OTHER);
}

/** The household trail entry deleteTransaction records after a committed delete. */
const TRAIL = 'audit_logs';
const loggedFor = (table: string, wrote: boolean) =>
  table === 'transactions' && wrote ? [{ table }, { table: TRAIL }] : [{ table }];
/** The transactions branch goes through lib/services/finances; the hub keeps its own sentence for a db failure. */
const dbFailureFor = (table: string, expected: string | null) =>
  (table === 'transactions' ? null : expected) ?? 'hubActions.couldNotDeleteTheWalletItem';

function expectDeleteState(deletedTable?: string) {
  for (const table of TABLES) {
    expect(db.table(table)).toEqual(table === deletedTable ? [KEEP, OTHER] : [TARGET, KEEP, OTHER]);
  }
}

beforeEach(() => {
  vi.resetAllMocks();
  asRole('parent');
  db = createInMemorySupabase();
  mocks.createServer.mockResolvedValue(db);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('addRewardAction', () => {
  beforeEach(() => db.replace('wallet_rewards', [{ ...OTHER }]));

  it.each(['parent', 'adult', ...NON_MANAGERS])('allows the authenticated %s and uses session family and creator', async (role) => {
    asRole(role);
    expect(await addRewardAction({ name: '  Reward program  ', family_id: 'hostile-family', created_by: 'hostile-user',
      member_id: 'hostile-member', unit: 'hostile-unit', value_cents: 999999 })).toEqual({ ok: true });
    await expectReward({ name: 'Reward program', ...REWARD_DEFAULTS });
  });

  it('propagates an authentication refusal before creating a client or writing', async () => {
    const refusal = new Error('synthetic auth refusal');
    mocks.requireUserContext.mockRejectedValue(refusal);
    await expect(addRewardAction({ name: 'Reward' })).rejects.toBe(refusal);
    expect(mocks.createServer).not.toHaveBeenCalled();
    expect(db.table('wallet_rewards')).toEqual([OTHER]);
  });

  it.each([undefined, '', ' \t\n ', null, 42])('refuses a blank or non-string program name (%j) before creating a client', async (name) => {
    expect(await addRewardAction({ name })).toEqual({ ok: false, error: 'hubActions.programNameIsRequired' });
    expect(mocks.createServer).not.toHaveBeenCalled();
    expect(db.table('wallet_rewards')).toEqual([OTHER]);
  });

  it('writes exactly the trimmed/capped reward fields and rounded value cents', async () => {
    expect(await addRewardAction({ name: ` ${'N'.repeat(125)} `, kind: 'miles', balance: ' 1234.5 ',
      value: ' 12.345 ', program: ` ${'P'.repeat(85)} ` })).toEqual({ ok: true });
    await expectReward({ name: 'N'.repeat(120), kind: 'miles', unit: 'miles', balance: 1234.5,
      value_cents: 1235, program: 'P'.repeat(80) });
  });

  it.each([['points', 'points'], ['miles', 'miles'], ['cashback', '$']])('pairs reward kind %s with its unit %s', async (kind, unit) => {
    expect(await addRewardAction({ name: 'Reward', kind, unit: 'forged', balance: 12.5, value: 2.5 })).toEqual({ ok: true });
    await expectReward({ ...REWARD_DEFAULTS, name: 'Reward', kind, unit, balance: 12.5, value_cents: 250 });
  });

  it.each([{ kind: 'unsupported', program: '  ' }, { kind: null, program: 42 }])('defaults invalid kind and optional program (%j)', async (input) => {
    expect(await addRewardAction({ name: 'Reward', ...input })).toEqual({ ok: true });
    await expectReward({ name: 'Reward', ...REWARD_DEFAULTS });
  });

  it.each([NaN, Infinity, -Infinity, 'invalid', null])('defaults non-finite or non-numeric balance/value (%s) to zero', async (amount) => {
    expect(await addRewardAction({ name: 'Reward', balance: amount, value: amount })).toEqual({ ok: true });
    await expectReward({ name: 'Reward', ...REWARD_DEFAULTS });
  });

  it.each(DATABASE_FAILURES)('sanitizes database failure $code without inserting a reward', async ({ code, expected }) => {
    failWrite('wallet_rewards', code);
    expect(await addRewardAction({ name: 'Reward' })).toEqual({ ok: false, error: expected ?? 'hubActions.couldNotAddTheReward' });
    expect(db.table('wallet_rewards')).toEqual([OTHER]);
    expect(db.log).toEqual([{ table: 'wallet_rewards' }]);
    expect(console.error).toHaveBeenCalledTimes(1);
  });
});

describe('deleteWalletRowAction', () => {
  beforeEach(() => {
    // Reuse IDs across separate tables to expose selecting the wrong branch.
    // Within each table every row has a distinct primary key.
    for (const table of TABLES) db.replace(table, [{ ...TARGET }, { ...KEEP }, { ...OTHER }]);
  });

  it('propagates an authentication refusal without creating a client or deleting', async () => {
    const refusal = new Error('synthetic auth refusal');
    mocks.requireUserContext.mockRejectedValue(refusal);
    await expect(deleteWalletRowAction({ table: 'wallet_rewards', id: TARGET.id })).rejects.toBe(refusal);
    expect(mocks.createServer).not.toHaveBeenCalled();
    expectDeleteState();
  });

  it.each(['wallets', 'members', '', 'Wallet_rewards', 'wallet_rewards;delete'])('refuses a table outside the allowlist (%j)', async (table) => {
    expect(await deleteWalletRowAction({ table, id: TARGET.id })).toEqual({ ok: false, error: 'hubActions.invalidRequest' });
    expect(mocks.createServer).not.toHaveBeenCalled();
    expect(db.log).toEqual([]);
    expectDeleteState();
  });

  describe.each(TABLES)('%s', (table) => {
    it.each(['parent', 'adult'])('lets a %s delete only the requested row in the requested table', async (role) => {
      asRole(role);
      expect(await deleteWalletRowAction({ table, id: TARGET.id })).toEqual({ ok: true });
      expect(db.log).toEqual(loggedFor(table, true));
      expect(mocks.createServer).toHaveBeenCalledTimes(1);
      expectDeleteState(table);
      const { data, error } = await db.from(table).select('id').eq('id', TARGET.id).maybeSingle();
      expect({ data, error }).toEqual({ data: null, error: null });
      expect(console.error).not.toHaveBeenCalled();
    });

    it('refuses an empty id before creating a client', async () => {
      expect(await deleteWalletRowAction({ table, id: '' })).toEqual({ ok: false, error: 'hubActions.invalidRequest' });
      expect(mocks.createServer).not.toHaveBeenCalled();
      expectDeleteState();
    });

    it.each(['missing-row', OTHER.id])('reports no deletion for the missing or foreign-family id %s', async (id) => {
      // Extra client fields cannot replace the active-family predicate.
      const input = { table, id, family_id: OTHER.family_id, familyId: OTHER.family_id };
      expect(await deleteWalletRowAction(input)).toEqual({ ok: false, error: 'hubActions.couldNotDeleteTheWalletItem' });
      expect(db.log).toEqual([{ table }]);
      expectDeleteState();
      expect(console.error).toHaveBeenCalledWith('[wallet] delete matched no row', { table, familyId: FAMILY });
    });

    it('refuses a null representation without an error or a persisted deletion', async () => {
      const from = db.from.bind(db);
      vi.spyOn(db, 'from').mockImplementation((name) => {
        const query = from(name);
        if (name === table) {
          // Synthetic no-op acknowledgement: the missing representation cannot
          // confirm success, and this execution leaves every row intact.
          const reply = { data: null, error: null, count: null, status: 204, statusText: 'No Content' };
          vi.spyOn(query, 'then').mockImplementation((resolve, reject) => Promise.resolve(reply).then(resolve, reject));
          // The transactions branch reads its reply through `.maybeSingle()` (lib/services/finances).
          vi.spyOn(query, 'maybeSingle').mockImplementation(() => Promise.resolve(reply) as never);
        }
        return query;
      });
      expect(await deleteWalletRowAction({ table, id: TARGET.id })).toEqual({ ok: false, error: 'hubActions.couldNotDeleteTheWalletItem' });
      expect(db.log).toEqual([{ table }]);
      expectDeleteState();
      expect(console.error).toHaveBeenCalledWith('[wallet] delete matched no row', { table, familyId: FAMILY });
    });

    it('reports failure when the same target is deleted a second time', async () => {
      expect(await deleteWalletRowAction({ table, id: TARGET.id })).toEqual({ ok: true });
      expectDeleteState(table);
      expect(console.error).not.toHaveBeenCalled();
      expect(await deleteWalletRowAction({ table, id: TARGET.id })).toEqual({ ok: false, error: 'hubActions.couldNotDeleteTheWalletItem' });
      expect(db.log).toEqual([...loggedFor(table, true), { table }]);
      expectDeleteState(table);
      expect(console.error).toHaveBeenCalledTimes(1);
      expect(console.error).toHaveBeenCalledWith('[wallet] delete matched no row', { table, familyId: FAMILY });
    });

    it.each(DATABASE_FAILURES)('sanitizes database failure $code without deleting rows', async ({ code, expected }) => {
      failWrite(table, code);
      expect(await deleteWalletRowAction({ table, id: TARGET.id })).toEqual({ ok: false, error: dbFailureFor(table, expected) });
      expect(db.log).toEqual([{ table }]);
      expectDeleteState();
      expect(console.error).toHaveBeenCalledTimes(1);
    });
  });

  describe.each(['financial_accounts', 'transactions'])('%s role guard', (table) => {
    it.each(NON_MANAGERS)('refuses a %s before creating a client', async (role) => {
      asRole(role);
      const input = { table, id: TARGET.id, role: 'parent' };
      expect(await deleteWalletRowAction(input)).toEqual({ ok: false, error: 'hubActions.onlyAParentOrAnother' });
      expect(mocks.createServer).not.toHaveBeenCalled();
      expectDeleteState();
    });
  });

  // Finding: the hub deleted transactions directly, so the family's history had
  // no entry for a money record removed here, while the same delete from
  // /dashboard/billing (lib/services/finances deleteTransaction) recorded one.
  describe('transactions go through the finances service', () => {
    it('records who removed the transaction on the household trail', async () => {
      db.replace('transactions', [{ ...TARGET, amount: 42 }, { ...KEEP }, { ...OTHER }]);
      expect(await deleteWalletRowAction({ table: 'transactions', id: TARGET.id })).toEqual({ ok: true });
      expect(db.table(TRAIL)).toEqual([expect.objectContaining({
        family_id: FAMILY, actor_id: USER, action: 'delete', resource: 'finances', resource_id: TARGET.id,
        metadata: { actor: 'member', title: 'Deleted $42.00 — Target record' },
      })]);
    });

    it('writes no trail entry when nothing was deleted', async () => {
      expect(await deleteWalletRowAction({ table: 'transactions', id: 'missing-row' })).toEqual({
        ok: false, error: 'hubActions.couldNotDeleteTheWalletItem',
      });
      expect(db.table(TRAIL)).toEqual([]);
    });
  });

  describe.each(['wallet_cards', 'wallet_passes', 'wallet_rewards'])('%s member writes', (table) => {
    it.each(NON_MANAGERS)('allows a %s to remove a manually tracked family record', async (role) => {
      asRole(role);
      expect(await deleteWalletRowAction({ table, id: TARGET.id })).toEqual({ ok: true });
      expect(db.log).toEqual([{ table }]);
      expectDeleteState(table);
    });
  });
});
