import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

/**
 * deleteWalletRowAction (app/(app)/wallet/hub-actions.ts) refused a member who
 * is not a parent or adult the household's accounts and transactions only. A
 * wallet card, pass or reward was deleted by its id and the family alone, so a
 * teen, a child, a caregiver or a guest who had a row's id (every member reads
 * these tables on the released schema, 0113) removed the parents' "Family Credit
 * Card", a parent's membership pass or a sibling's reward program from the hub,
 * and was told it was done.
 *
 * The hub shows such a member their own rows only, and files what they add on
 * them (ownerOfNew), so their delete now matches their own rows only: the
 * household's (filed on nobody) and a sibling's answer as a row that could not
 * be deleted, and stay. A parent or adult still tidies any of them.
 *
 * Finding N3 (child-money-scope). The database is in-memory; nothing here
 * establishes row-level security.
 */
const mocks = vi.hoisted(() => ({ createServer: vi.fn(), requireUserContext: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
// The step-up on the household-money tables has its own test; these three
// tables are not household money and never ask for it.
vi.mock('@/lib/auth/require-aal2', () => ({ aal2Verdict: async () => ({ action: 'allow' }) }));

const { deleteWalletRowAction } = await import('@/app/(app)/wallet/hub-actions');

const FAMILY = 'family-1';
const SELF = 'member-self';
const TABLES = ['wallet_cards', 'wallet_passes', 'wallet_rewards'];
const NOT_MANAGERS = ['teen', 'child', 'caregiver', 'guest'];
const COULD_NOT_DELETE = { ok: false, error: 'hubActions.couldNotDeleteTheWalletItem' };

let db: InMemorySupabase;

function asRole(role: string) {
  mocks.requireUserContext.mockResolvedValue({
    user: { id: 'user-self' },
    active: { familyId: FAMILY, role, member: { id: SELF }, family: { id: FAMILY, timezone: 'UTC' } },
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase();
  mocks.createServer.mockResolvedValue(db);
  for (const table of TABLES) {
    db.replace(table, [
      { id: 'household', family_id: FAMILY, member_id: null, name: 'Family Credit Card' },
      { id: 'sibling', family_id: FAMILY, member_id: 'member-sibling', name: 'Sibling reward' },
      { id: 'own', family_id: FAMILY, member_id: SELF, name: 'Library card' },
    ]);
  }
});
afterEach(() => vi.restoreAllMocks());

const left = (table: string) => db.table(table).map((row) => row.id);

describe.each(TABLES)('a %s row is removed by a parent or adult, or by the member it is filed on', (table) => {
  it.each(NOT_MANAGERS)('a %s cannot remove the household\'s row, filed on nobody', async (role) => {
    asRole(role);

    expect(await deleteWalletRowAction({ table, id: 'household' })).toEqual(COULD_NOT_DELETE);
    expect(left(table)).toEqual(['household', 'sibling', 'own']);
  });

  it.each(NOT_MANAGERS)('a %s cannot remove a sibling\'s row', async (role) => {
    asRole(role);

    expect(await deleteWalletRowAction({ table, id: 'sibling' })).toEqual(COULD_NOT_DELETE);
    expect(left(table)).toEqual(['household', 'sibling', 'own']);
  });

  it.each(NOT_MANAGERS)('a %s still removes their own row', async (role) => {
    asRole(role);

    expect(await deleteWalletRowAction({ table, id: 'own' })).toEqual({ ok: true });
    expect(left(table)).toEqual(['household', 'sibling']);
  });

  it.each(['parent', 'adult'])('a %s still removes the household\'s row and a child\'s', async (role) => {
    asRole(role);

    expect(await deleteWalletRowAction({ table, id: 'household' })).toEqual({ ok: true });
    expect(await deleteWalletRowAction({ table, id: 'sibling' })).toEqual({ ok: true });
    expect(left(table)).toEqual(['own']);
  });
});
