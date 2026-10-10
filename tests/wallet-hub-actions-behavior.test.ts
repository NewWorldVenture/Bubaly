import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addAccountAction, addTransactionAction } from '@/app/(app)/wallet/hub-actions';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

// MAIN-F-F07 / ACTION-EC8D89991D6B / ACTION-2C2B60DC5F0C.
// Execute the exports and read their persisted payloads. The fake has no RLS
// or schema constraints: these cases prove action behavior, not DB policies.
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
const MEMBER = 'session-member';
const OTHER = { id: 'other-record', family_id: 'other-family', created_by: 'other-user', name: 'Other record' };
const cases = [
  { name: 'addAccountAction', action: addAccountAction, table: 'financial_accounts',
    nameError: 'hubActions.accountNameIsRequired', writeError: 'hubActions.couldNotAddTheAccount' },
  { name: 'addTransactionAction', action: addTransactionAction, table: 'transactions',
    nameError: 'hubActions.descriptionIsRequired', writeError: 'hubActions.couldNotAddTheTransaction' },
];
let db: InMemorySupabase;

function asRole(role: string, timezone: string | null = 'America/Los_Angeles') {
  mocks.requireUserContext.mockResolvedValue({
    user: { id: USER },
    active: { familyId: FAMILY, role, member: { id: MEMBER }, family: { timezone } },
  });
}

async function readInserted(table: string) {
  const result = await db.from(table).select('*').eq('family_id', FAMILY).single();
  expect(result.error).toBeNull();
  expect(result.data).not.toBeNull();
  expect(db.table(table)).toHaveLength(2);
  expect(db.table(table).find((row) => row.id === OTHER.id)).toEqual(OTHER);
  return result.data;
}

function failInsert(table: string, error: { code?: string; message: string }) {
  const from = db.from.bind(db);
  vi.spyOn(db, 'from').mockImplementation((name) => {
    const query = from(name);
    if (name === table) {
      // Return the failed write before the real in-memory insert can execute.
      const reply = { data: null, error: { code: 'XX000', details: null, hint: null, ...error },
        count: null, status: 400, statusText: 'Bad Request' };
      vi.spyOn(query, 'then').mockImplementation((resolve, reject) => Promise.resolve(reply).then(resolve, reject));
    }
    return query;
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-30T02:30:00Z'));
  asRole('parent');
  db = createInMemorySupabase();
  // Keep a foreign-family row to verify that a successful insert adds exactly
  // one session-scoped record, without changing an existing household's row.
  db.replace('financial_accounts', [{ ...OTHER }]);
  db.replace('transactions', [{ ...OTHER }]);
  mocks.createServer.mockResolvedValue(db);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe.each(cases)('$name', ({ action, table, nameError, writeError }) => {
  it.each(['child', 'teen', 'caregiver', 'guest'])('refuses a %s before creating a client', async (role) => {
    asRole(role);
    expect(await action({ name: 'Valid name', role: 'parent' })).toEqual({
      ok: false, error: 'hubActions.onlyAParentOrAnother',
    });
    expect(mocks.createServer).not.toHaveBeenCalled();
    expect(db.table(table)).toEqual([OTHER]);
  });

  it.each(['parent', 'adult'])('allows a %s and persists session-owned family and creator fields', async (role) => {
    asRole(role);
    expect(await action({ name: '  Household record  ', family_id: 'hostile-family', created_by: 'hostile-user' })).toEqual({ ok: true });
    expect(await readInserted(table)).toMatchObject({ name: 'Household record', family_id: FAMILY, created_by: USER });
    expect(mocks.createServer).toHaveBeenCalledTimes(1);
  });

  it.each(['', ' \t\n ', null, 42])('refuses an empty or non-string name (%j) before creating a client', async (name) => {
    expect(await action({ name })).toEqual({ ok: false, error: nameError });
    expect(mocks.createServer).not.toHaveBeenCalled();
    expect(db.table(table)).toEqual([OTHER]);
  });

  it.each([
    { label: 'coded database detail', code: 'XX000', message: 'private table and constraint detail', permission: false },
    { label: 'uncoded database detail', code: '', message: 'private table and constraint detail', permission: false },
    { label: 'permission refusal', code: '42501', message: 'private table and constraint detail', permission: true },
  ])('sanitizes $label and leaves the table unchanged', async ({ code, message, permission }) => {
    failInsert(table, { code, message });
    expect(await action({ name: 'Valid name' })).toEqual({
      ok: false,
      error: permission ? "You don't have permission to do that. Ask a family admin if you think this is a mistake." : writeError,
    });
    expect(db.table(table)).toEqual([OTHER]);
    expect(mocks.createServer).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalledTimes(1);
  });
});

describe('addAccountAction normalization and defaults', () => {
  it('trims and caps text while preserving a signed dollar balance', async () => {
    expect(await addAccountAction({
      name: `  ${'N'.repeat(125)}  `, institution: `  ${'I'.repeat(125)}  `,
      last_four: ' 123456 ', balance: ' -123.45 ', type: 'investment',
    })).toEqual({ ok: true });
    expect(await readInserted('financial_accounts')).toMatchObject({
      name: 'N'.repeat(120), institution: 'I'.repeat(120), last_four: '1234',
      balance: -123.45, type: 'investment', family_id: FAMILY, created_by: USER,
    });
  });

  it.each(['checking', 'savings', 'credit', 'investment', 'retirement'])('retains the supported account type %s', async (type) => {
    expect(await addAccountAction({ name: 'Account', type, balance: 25.5 })).toEqual({ ok: true });
    expect(await readInserted('financial_accounts')).toMatchObject({ type, balance: 25.5 });
  });

  it.each([{}, { type: 'unsupported', institution: '  ', last_four: 1234 }])('defaults unsupported or missing account fields (%j)', async (input) => {
    expect(await addAccountAction({ name: 'Account', ...input })).toEqual({ ok: true });
    expect(await readInserted('financial_accounts')).toMatchObject({
      type: 'checking', institution: null, last_four: null, balance: 0,
    });
  });

  it.each([NaN, Infinity, -Infinity, 'not-money', null])('normalizes a non-finite or missing balance (%s) to zero', async (balance) => {
    expect(await addAccountAction({ name: 'Account', balance })).toEqual({ ok: true });
    expect(await readInserted('financial_accounts')).toMatchObject({ balance: 0 });
  });
});

describe('addTransactionAction normalization and defaults', () => {
  it('trims and caps text, normalizes the amount, and preserves an explicit date and account', async () => {
    expect(await addTransactionAction({
      name: `  ${'N'.repeat(125)}  `, merchant: `  ${'M'.repeat(85)}  `, category: `  ${'C'.repeat(45)}  `,
      amount: ' -12.34 ', type: 'transfer', status: 'pending', account_id: 'account-a', date: '2024-02-29',
    })).toEqual({ ok: true });
    expect(await readInserted('transactions')).toMatchObject({
      name: 'N'.repeat(120), merchant: 'M'.repeat(80), category: 'C'.repeat(40),
      amount: 12.34, type: 'transfer', status: 'pending', account_id: 'account-a', date: '2024-02-29',
      family_id: FAMILY, created_by: USER,
    });
  });

  it.each([
    ['income', 'posted'], ['expense', 'pending'], ['transfer', 'cleared'], ['expense', 'failed'], ['expense', 'scheduled'],
  ])('retains supported transaction type %s and status %s', async (type, status) => {
    expect(await addTransactionAction({ name: 'Transaction', type, status, amount: 25.5 })).toEqual({ ok: true });
    expect(await readInserted('transactions')).toMatchObject({ type, status, amount: 25.5 });
  });

  it.each([{}, { type: 'unsupported', status: 'unsupported', merchant: '  ', category: 123, account_id: 123 }])('defaults unsupported or missing transaction fields (%j)', async (input) => {
    expect(await addTransactionAction({ name: 'Transaction', ...input })).toEqual({ ok: true });
    expect(await readInserted('transactions')).toMatchObject({
      type: 'expense', status: 'posted', merchant: null, category: null, account_id: null, amount: 0,
    });
  });

  it.each([NaN, Infinity, -Infinity, 'not-money', null])('normalizes a non-finite or missing amount (%s) to zero', async (amount) => {
    expect(await addTransactionAction({ name: 'Transaction', amount })).toEqual({ ok: true });
    expect(await readInserted('transactions')).toMatchObject({ amount: 0 });
  });

  it.each([
    { timezone: 'America/Los_Angeles', now: '2026-09-30T02:30:00Z', expected: '2026-09-29' },
    { timezone: 'Asia/Tokyo', now: '2026-09-30T18:30:00Z', expected: '2026-10-01' },
  ])('uses the session family date in $timezone when a date is missing, empty, or non-string', async ({ timezone, now, expected }) => {
    asRole('parent', timezone);
    vi.setSystemTime(new Date(now));
    for (const date of [undefined, '', null, 123]) {
      db.replace('transactions', [{ ...OTHER }]);
      expect(await addTransactionAction({ name: 'Transaction', date, timezone: 'UTC' })).toEqual({ ok: true });
      expect(await readInserted('transactions')).toMatchObject({ date: expected });
    }
  });

  it('defaults the date to UTC when the session family has no timezone', async () => {
    asRole('parent', null);
    expect(await addTransactionAction({ name: 'Transaction' })).toEqual({ ok: true });
    expect(await readInserted('transactions')).toMatchObject({ date: '2026-09-30' });
  });
});
