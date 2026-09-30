import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addCardAction, addPassAction } from '@/app/(app)/wallet/hub-actions';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

// MAIN-F-F07: ACTION-D2385E96A93B / ACTION-7CA10A51A8B8.
// These are manually tracked family records, not issued payment cards. Per
// docs/wallet-hub-supabase.md, all family-member roles may add them. The fake
// proves action payloads and persistence, not RLS, schema constraints or UI
// refresh: the caller's useAddForm owns refresh after a successful result.
const mocks = vi.hoisted(() => ({ createServer: vi.fn(), requireUserContext: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

const FAMILY = 'session-family';
const USER = 'session-user';
const OTHER = { id: 'foreign-row', family_id: 'foreign-family', name: 'Foreign record' };
const cases = [
  { name: 'addCardAction', action: addCardAction, table: 'wallet_cards',
    nameError: 'hubActions.cardNameIsRequired', writeError: 'hubActions.couldNotAddTheCard',
    defaults: { brand: 'other', kind: 'credit', last_four: null, available_cents: 0, limit_cents: null, color: null } },
  { name: 'addPassAction', action: addPassAction, table: 'wallet_passes',
    nameError: 'hubActions.passNameIsRequired', writeError: 'hubActions.couldNotAddThePass',
    defaults: { kind: 'membership', status: null, detail: null, member_no: null } },
];
let db: InMemorySupabase;

function asRole(role: string) {
  mocks.requireUserContext.mockResolvedValue({
    user: { id: USER }, active: { familyId: FAMILY, role, member: { id: 'session-member' } },
  });
}

async function expectInsert(table: string, payload: Row) {
  // Inspect the write before the separate readback adds its own query.
  expect(db.log).toEqual([{ table }]);
  expect(mocks.createServer).toHaveBeenCalledTimes(1);
  const { data, error } = await db.from(table).select('*').eq('family_id', FAMILY).single();
  expect(error).toBeNull();
  expect(data).toEqual({ ...payload, family_id: FAMILY, created_by: USER,
    id: expect.any(String), created_at: expect.any(String), updated_at: expect.any(String) });
  expect(db.table(table)).toHaveLength(2);
  expect(db.table(table).find((row) => row.id === OTHER.id)).toEqual(OTHER);
}

function failWrite(table: string, code: string) {
  const from = db.from.bind(db);
  vi.spyOn(db, 'from').mockImplementation((name) => {
    const query = from(name);
    if (name === table) {
      const reply = { data: null, error: { code, message: 'private relation and constraint detail', details: null, hint: null },
        count: null, status: 400, statusText: 'Bad Request' };
      vi.spyOn(query, 'then').mockImplementation((resolve, reject) => Promise.resolve(reply).then(resolve, reject));
    }
    return query;
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  asRole('parent');
  db = createInMemorySupabase();
  for (const { table } of cases) db.replace(table, [{ ...OTHER }]);
  mocks.createServer.mockResolvedValue(db);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe.each(cases)('$name', ({ action, table, defaults, nameError, writeError }) => {
  it.each(['parent', 'adult', 'teen', 'child', 'caregiver', 'guest'])('allows the authenticated %s and writes only session family/creator fields', async (role) => {
    asRole(role);
    expect(await action({ name: '  Family record  ', family_id: 'hostile-family', created_by: 'hostile-user', member_id: 'hostile-member' })).toEqual({ ok: true });
    await expectInsert(table, { name: 'Family record', ...defaults });
  });

  it('propagates an authentication refusal without creating a client or writing', async () => {
    const refusal = new Error('synthetic auth refusal');
    mocks.requireUserContext.mockRejectedValue(refusal);
    await expect(action({ name: 'Record' })).rejects.toBe(refusal);
    expect(mocks.createServer).not.toHaveBeenCalled();
    expect(db.table(table)).toEqual([OTHER]);
  });

  it.each([undefined, '', ' \t\n ', null, 42])('refuses blank or non-string names (%j) without writing', async (name) => {
    expect(await action({ name })).toEqual({ ok: false, error: nameError });
    expect(mocks.createServer).not.toHaveBeenCalled();
    expect(db.table(table)).toEqual([OTHER]);
  });

  it.each([
    ['XX000', null], ['', null],
    ['42501', "You don't have permission to do that. Ask a family admin if you think this is a mistake."],
    ['23514', 'Some required information is missing or invalid. Please review and try again.'],
  ])('sanitizes database failure %j and leaves existing rows unchanged', async (code, message) => {
    failWrite(table, code!);
    expect(await action({ name: 'Record' })).toEqual({ ok: false, error: message ?? writeError });
    expect(db.table(table)).toEqual([OTHER]);
    expect(db.log).toEqual([{ table }]);
    expect(console.error).toHaveBeenCalledTimes(1);
  });
});

describe('addCardAction fields', () => {
  it('writes exactly the trimmed/capped fields and rounded integer cents', async () => {
    expect(await addCardAction({ name: ` ${'N'.repeat(125)} `, brand: 'visa', kind: 'debit',
      last_four: ' 123456 ', available: ' 12.345 ', limit: '100.126', color: ` ${'c'.repeat(20)} ` })).toEqual({ ok: true });
    await expectInsert('wallet_cards', { name: 'N'.repeat(120), brand: 'visa', kind: 'debit',
      last_four: '1234', available_cents: 1235, limit_cents: 10013, color: 'c'.repeat(16) });
  });

  it.each(['visa', 'mastercard', 'amex', 'discover', 'other'])('retains supported brand %s', async (brand) => {
    expect(await addCardAction({ name: 'Card', brand })).toEqual({ ok: true });
    await expectInsert('wallet_cards', { ...cases[0].defaults, name: 'Card', brand });
  });

  it.each(['credit', 'debit', 'gas', 'store', 'prepaid', 'other'])('retains supported kind %s', async (kind) => {
    expect(await addCardAction({ name: 'Card', kind })).toEqual({ ok: true });
    await expectInsert('wallet_cards', { ...cases[0].defaults, name: 'Card', kind });
  });

  it('defaults unsupported enums and blank/non-string optional text', async () => {
    expect(await addCardAction({ name: 'Card', brand: 'unsupported', kind: 'unsupported', last_four: 1234, color: '  ' })).toEqual({ ok: true });
    await expectInsert('wallet_cards', { ...cases[0].defaults, name: 'Card' });
  });

  it.each([undefined, null, ''])('keeps an omitted limit (%j) distinct from zero', async (limit) => {
    expect(await addCardAction({ name: 'Card', limit })).toEqual({ ok: true });
    await expectInsert('wallet_cards', { ...cases[0].defaults, name: 'Card' });
  });

  it.each([0, '0'])('retains an explicit zero limit (%j)', async (limit) => {
    expect(await addCardAction({ name: 'Card', limit })).toEqual({ ok: true });
    await expectInsert('wallet_cards', { ...cases[0].defaults, name: 'Card', limit_cents: 0 });
  });

  it.each([NaN, Infinity, -Infinity, 'invalid'])('defaults non-finite or non-numeric available values (%s)', async (available) => {
    expect(await addCardAction({ name: 'Card', available })).toEqual({ ok: true });
    await expectInsert('wallet_cards', { ...cases[0].defaults, name: 'Card' });
  });
});

describe('addPassAction fields', () => {
  it('writes exactly the trimmed and capped pass fields', async () => {
    expect(await addPassAction({ name: ` ${'N'.repeat(125)} `, kind: 'transit', status: ` ${'S'.repeat(65)} `,
      detail: ` ${'D'.repeat(125)} `, member_no: ` ${'M'.repeat(65)} ` })).toEqual({ ok: true });
    await expectInsert('wallet_passes', { name: 'N'.repeat(120), kind: 'transit', status: 'S'.repeat(60),
      detail: 'D'.repeat(120), member_no: 'M'.repeat(60) });
  });

  it.each(['membership', 'loyalty', 'ticket', 'insurance', 'transit', 'other'])('retains supported kind %s', async (kind) => {
    expect(await addPassAction({ name: 'Pass', kind })).toEqual({ ok: true });
    await expectInsert('wallet_passes', { ...cases[1].defaults, name: 'Pass', kind });
  });

  it('defaults an unsupported kind and blank/non-string optional fields', async () => {
    expect(await addPassAction({ name: 'Pass', kind: 'unsupported', status: ' ', detail: 42, member_no: null })).toEqual({ ok: true });
    await expectInsert('wallet_passes', { ...cases[1].defaults, name: 'Pass' });
  });
});
