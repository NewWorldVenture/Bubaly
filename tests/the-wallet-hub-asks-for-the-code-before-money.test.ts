// A parent with an authenticator signs in with the password alone (aal1).
// `deleteTransactionAction` on /dashboard/billing refuses that session, and
// tests/a-password-alone-does-not-empty-the-family-finances.test.ts pins it.
// The wallet hub deletes the SAME rows — `transactions`, `financial_accounts` —
// through `deleteWalletRowAction`, which checked the role and nothing else, and
// the database's step-up backstop (0382) covers budgets, savings goals and bills
// only. So the ledger the billing page guards could be emptied from /wallet.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const mocks = vi.hoisted(() => ({ createServer: vi.fn(), requireUserContext: vi.fn(), aal: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

const { addAccountAction, addTransactionAction, deleteWalletRowAction } = await import('@/app/(app)/wallet/hub-actions');

const FAMILY = 'fam-1';
const ENROLLED_NO_CODE_YET = { data: { currentLevel: 'aal1', nextLevel: 'aal2' }, error: null };
const CODE_ENTERED = { data: { currentLevel: 'aal2', nextLevel: 'aal2' }, error: null };
const NEVER_ENROLLED = { data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null };
const NEEDS_CODE = { ok: false, error: 'actions.moneyNeedsYourCodeAgain', stepUp: '/auth/step-up?next=%2Fwallet' };

let db: InMemorySupabase;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireUserContext.mockResolvedValue({
    user: { id: 'user-1' },
    active: { familyId: FAMILY, role: 'parent', member: { id: 'mem-1' }, family: { timezone: 'UTC' } },
  });
  db = createInMemorySupabase();
  Object.assign(db.auth, { mfa: { getAuthenticatorAssuranceLevel: mocks.aal } });
  db.replace('transactions', [{ id: 'tx-1', family_id: FAMILY, name: 'Rent', amount: 1200 }]);
  db.replace('financial_accounts', [{ id: 'acct-1', family_id: FAMILY, name: 'Checking' }]);
  db.replace('wallet_cards', [{ id: 'card-1', family_id: FAMILY, name: 'Library card' }]);
  mocks.createServer.mockResolvedValue(db);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe('the wallet hub, reached with the password alone', () => {
  beforeEach(() => { mocks.aal.mockResolvedValue(ENROLLED_NO_CODE_YET); });

  it.each([
    ['transactions', 'tx-1'],
    ['financial_accounts', 'acct-1'],
  ])('leaves the %s row where it was and says the code is missing', async (table, id) => {
    expect(await deleteWalletRowAction({ table, id })).toEqual(NEEDS_CODE);
    expect(db.table(table).map((r) => r.id)).toEqual([id]);
  });

  it('adds no transaction or account either', async () => {
    expect(await addTransactionAction({ name: 'Groceries', amount: 40 })).toEqual(NEEDS_CODE);
    expect(await addAccountAction({ name: 'Savings', type: 'savings' })).toEqual(NEEDS_CODE);
    expect(db.table('transactions')).toHaveLength(1);
    expect(db.table('financial_accounts')).toHaveLength(1);
  });

  it('still lets the family tidy a wallet card, which is not household money', async () => {
    expect(await deleteWalletRowAction({ table: 'wallet_cards', id: 'card-1' })).toEqual({ ok: true });
    expect(db.table('wallet_cards')).toEqual([]);
  });
});

describe('the same clicks once the code is entered, or with no authenticator at all', () => {
  it.each([['code entered', CODE_ENTERED], ['never enrolled', NEVER_ENROLLED]])('%s: the delete goes through', async (_label, level) => {
    mocks.aal.mockResolvedValue(level);
    expect(await deleteWalletRowAction({ table: 'transactions', id: 'tx-1' })).toEqual({ ok: true });
    expect(db.table('transactions')).toEqual([]);
  });
});
