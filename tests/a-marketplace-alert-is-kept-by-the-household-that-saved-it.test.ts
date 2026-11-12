// Call-level role tests for the Marketplace saved-search actions
// (app/(app)/marketplace/alerts/actions.ts), Register B rows
// ACTION-B47AF4698D24, ACTION-1BD84D020C84 and ACTION-C6976CF78076.
//
// THE POLICY, from the sources rather than from the action:
//   - /marketplace is plan level 0 and not manager-only (lib/constants/navigation.ts:173),
//     and no guest area covers it (lib/auth/guest-scope.ts).
//   - The alerts page offers the composer and the per-alert actions to every
//     member, and lists only the reader's own saved searches
//     (app/(app)/marketplace/alerts/page.tsx: `.eq('member_id', meId)`).
//   - The live policies are 0152's: select/insert/update/delete on
//     `is_family_member(family_id)`, no role (supabase/migrations/0152_marketplace_saved_searches.sql:37-43).
// So a parent, adult, teen, child (a kid login included) and caregiver of
// household A save, delete and mark their own searches, and an id from
// household B is a write that touches no row and is refused.
//
// NOT PINNED, for the owner (see the PR body): a guest's writes (the page and
// 0152 allow them; the role's description is "view") and one member deleting or
// marking ANOTHER member's search in the same family (the page shows only your
// own; the action and 0152 filter by family only).
//
// The real actions run against the in-memory PostgREST fake; only the signed-in
// context, the request-bound server client, the translator and revalidatePath
// are stubbed.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const mocks = vi.hoisted(() => ({
  requireUserContext: vi.fn(),
  createServer: vi.fn(),
  revalidatePath: vi.fn(),
}));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));

const { createSavedSearchAction, deleteSavedSearchAction, markSearchSeenAction } =
  await import('@/app/(app)/marketplace/alerts/actions');

const FAMILY_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const FAMILY_B = 'bbbbbbbb-0000-4000-8000-000000000001';
const B_MEMBER = 'bbbbbbbb-0000-4000-8000-0000000000b1';
/** Each member's own saved search: the member id with its last two characters swapped for `5e`. */
const A_SEARCH_OF = (memberId: string) => `${memberId.slice(0, 34)}5e`;
const B_SEARCH = 'bbbbbbbb-0000-4000-8000-0000000005e1';
const OLD_SEEN = '2026-01-01T00:00:00.000Z';

const ROLES = ['parent', 'adult', 'teen', 'child', 'caregiver'] as const;
type Role = (typeof ROLES)[number] | 'guest';

const MEMBER_IDS: Record<string, string> = {
  parent: 'aaaaaaaa-0000-4000-8000-0000000000a1',
  adult: 'aaaaaaaa-0000-4000-8000-0000000000a2',
  teen: 'aaaaaaaa-0000-4000-8000-0000000000a3',
  child: 'aaaaaaaa-0000-4000-8000-0000000000a4',
  kid: 'aaaaaaaa-0000-4000-8000-0000000000a5',
  caregiver: 'aaaaaaaa-0000-4000-8000-0000000000a6',
  guest: 'aaaaaaaa-0000-4000-8000-0000000000a7',
};
const memberOf = (role: Role, kid = false) => MEMBER_IDS[kid ? 'kid' : role];

let db: InMemorySupabase;

function signInAs(role: Role, kid = false) {
  const id = memberOf(role, kid);
  mocks.requireUserContext.mockResolvedValue({
    user: { id: `user-${role}${kid ? '-kid' : ''}`, email: kid ? `${role}@kids.bubaly.app` : `${role}@example.com` },
    memberships: [],
    active: { familyId: FAMILY_A, family: { id: FAMILY_A, timezone: 'UTC' }, role, member: { id, family_id: FAMILY_A } },
  });
  return id;
}

const searchRow = (id: string, familyId: string, memberId: string) => ({
  id, family_id: familyId, member_id: memberId, label: 'Bikes', query: 'bike', kind: null, category: null,
  max_price_cents: null, last_seen_at: OLD_SEEN, created_by: `user-${memberId}`, created_at: OLD_SEEN,
});

const snapshot = () => structuredClone(db.table('marketplace_saved_searches'));

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase();
  mocks.createServer.mockImplementation(async () => db);
  db.seed('marketplace_saved_searches', [searchRow(B_SEARCH, FAMILY_B, B_MEMBER)]);
});

const CASES: { label: string; role: Role; kid: boolean }[] = [
  ...ROLES.map((role) => ({ label: role, role, kid: false })),
  { label: 'child on a kid login', role: 'child', kid: true },
];

describe('ACTION-B47AF4698D24 createSavedSearchAction', () => {
  it.each(CASES)('ACTION-B47AF4698D24 a $label of household A saves a search in their own name and family', async ({ role, kid }) => {
    const me = signInAs(role, kid);
    const result = await createSavedSearchAction({ label: ' Bikes ', query: ' bike ', kind: 'sell', category: 'toys', maxPrice: '25.50' });

    expect(result).toEqual({ ok: true });
    const mine = db.table('marketplace_saved_searches').filter((r) => r.family_id === FAMILY_A);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      family_id: FAMILY_A, member_id: me, label: 'Bikes', query: 'bike', kind: 'sell', category: 'toys',
      max_price_cents: 2550, created_by: `user-${role}${kid ? '-kid' : ''}`,
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/marketplace/alerts');
  });

  it('ACTION-B47AF4698D24 writes into the caller’s household even when the form names nothing of B, and B’s row is untouched', async () => {
    const before = db.table('marketplace_saved_searches').find((r) => r.id === B_SEARCH);
    const frozen = structuredClone(before);
    signInAs('parent');
    expect(await createSavedSearchAction({ query: 'stroller' })).toEqual({ ok: true });
    expect(db.table('marketplace_saved_searches').filter((r) => r.family_id === FAMILY_B)).toEqual([frozen]);
  });

  it('ACTION-B47AF4698D24 refuses a search with no criterion and writes nothing', async () => {
    signInAs('parent');
    const before = snapshot();
    expect(await createSavedSearchAction({ label: 'Nothing', kind: 'not-a-kind', category: 'nope', maxPrice: '-3' }))
      .toEqual({ ok: false, error: 'actions.addAKeywordOrA' });
    expect(snapshot()).toEqual(before);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('ACTION-B47AF4698D24 reports a refused insert instead of claiming it saved', async () => {
    signInAs('teen');
    const refusing = {
      from: (name: string) => {
        const builder = db.from(name);
        return Object.assign(builder, {
          insert: () => Promise.resolve({ data: null, error: { code: '42501', message: 'new row violates row-level security policy' } }),
        });
      },
    };
    mocks.createServer.mockImplementation(async () => refusing);
    const result = await createSavedSearchAction({ query: 'bike' });
    expect(result.ok).toBe(false);
    expect(db.table('marketplace_saved_searches').filter((r) => r.family_id === FAMILY_A)).toEqual([]);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });
});

describe('ACTION-1BD84D020C84 deleteSavedSearchAction', () => {
  it.each(CASES)('ACTION-1BD84D020C84 a $label of household A deletes their own search, and only it', async ({ role, kid }) => {
    const me = signInAs(role, kid);
    db.seed('marketplace_saved_searches', [searchRow(A_SEARCH_OF(me), FAMILY_A, me)]);
    const bBefore = structuredClone(db.table('marketplace_saved_searches').filter((r) => r.family_id === FAMILY_B));

    expect(await deleteSavedSearchAction(A_SEARCH_OF(me))).toEqual({ ok: true });

    expect(db.table('marketplace_saved_searches').filter((r) => r.family_id === FAMILY_A)).toEqual([]);
    expect(db.table('marketplace_saved_searches').filter((r) => r.family_id === FAMILY_B)).toEqual(bBefore);
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/marketplace/alerts');
  });

  it.each(CASES)('ACTION-1BD84D020C84 a $label of household A cannot delete household B’s search', async ({ role, kid }) => {
    const me = signInAs(role, kid);
    db.seed('marketplace_saved_searches', [searchRow(A_SEARCH_OF(me), FAMILY_A, me)]);
    const before = snapshot();

    expect(await deleteSavedSearchAction(B_SEARCH)).toEqual({ ok: false, error: 'alerts.couldNotDeleteTheSavedSearch' });

    expect(snapshot()).toEqual(before);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('ACTION-1BD84D020C84 refuses an empty id before reading anything', async () => {
    signInAs('parent');
    const before = snapshot();
    expect(await deleteSavedSearchAction('')).toEqual({ ok: false, error: 'actions.invalidAlert' });
    expect(snapshot()).toEqual(before);
    expect(mocks.createServer).not.toHaveBeenCalled();
  });
});

describe('ACTION-C6976CF78076 markSearchSeenAction', () => {
  it.each(CASES)('ACTION-C6976CF78076 a $label of household A advances their own search’s seen cursor', async ({ role, kid }) => {
    const me = signInAs(role, kid);
    db.seed('marketplace_saved_searches', [searchRow(A_SEARCH_OF(me), FAMILY_A, me)]);
    const startedAt = Date.now();

    expect(await markSearchSeenAction(A_SEARCH_OF(me))).toEqual({ ok: true });

    const row = db.table('marketplace_saved_searches').find((r) => r.id === A_SEARCH_OF(me));
    expect(Date.parse(String(row?.last_seen_at))).toBeGreaterThanOrEqual(startedAt);
    expect(row).toMatchObject({ family_id: FAMILY_A, member_id: me, query: 'bike', label: 'Bikes' });
    expect(db.table('marketplace_saved_searches').find((r) => r.id === B_SEARCH)?.last_seen_at).toBe(OLD_SEEN);
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/marketplace/alerts');
  });

  it.each(CASES)('ACTION-C6976CF78076 a $label of household A cannot move household B’s cursor', async ({ role, kid }) => {
    const me = signInAs(role, kid);
    db.seed('marketplace_saved_searches', [searchRow(A_SEARCH_OF(me), FAMILY_A, me)]);
    const before = snapshot();

    expect(await markSearchSeenAction(B_SEARCH)).toEqual({ ok: false, error: 'alerts.couldNotMarkTheSavedSearch' });

    expect(snapshot()).toEqual(before);
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it('ACTION-C6976CF78076 refuses an empty id before reading anything', async () => {
    signInAs('parent');
    const before = snapshot();
    expect(await markSearchSeenAction('')).toEqual({ ok: false, error: 'actions.invalidAlert' });
    expect(snapshot()).toEqual(before);
    expect(mocks.createServer).not.toHaveBeenCalled();
  });
});
