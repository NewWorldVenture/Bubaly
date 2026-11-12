// Call-level role tests for app/(app)/dashboard/dining/actions.ts.
//
// THE POLICY, from the sources:
//   - dining_out's live policies are 0481:556-586. Any member but a guest may
//     insert a row they create (`created_by = auth.uid()`), and any member but a
//     guest may heart a place (`dining_out_update`, with a trigger that limits a
//     non-creator, non-manager to `is_favorite`). Reads are every member's.
//   - /dashboard/dining is not in the feature catalog (no plan gate) and is not
//     on a guest's withheld list (lib/auth/guest-scope.ts).
//   - Every write is scoped to the session's household: the insert takes
//     family_id from the session, the heart filters `.eq('family_id')`.
//
// A GUEST is deliberately not pinned here: the action has no role check of its
// own and relies on RLS alone to refuse a guest, so in this harness (which has
// no RLS) a guest's write lands. That is reported in the PR as a defect rather
// than committed as a failing or inverted case.
//
// Only the session, the client factory, the translator and next/cache are
// stubbed; the action and the error mapping are the real code.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { CHILD_LOGIN_EMAIL_DOMAIN } from '@/lib/onboarding/child-login';

const mocks = vi.hoisted(() => ({
  requireUserContext: vi.fn(),
  client: null as unknown,
}));

vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => mocks.client }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { addRestaurantAction, logVisitAction, toggleFavoriteAction } = await import('@/app/(app)/dashboard/dining/actions');

const FAMILY_A = 'a0000000-0000-4000-8000-00000000000a';
const FAMILY_B = 'b0000000-0000-4000-8000-00000000000b';
/** The roles the sources let write dining_out. */
const WRITERS = ['parent', 'adult', 'teen', 'child', 'caregiver'] as const;
type Writer = (typeof WRITERS)[number];

const USER: Record<Writer | 'kid' | 'creator' | 'other', string> = {
  parent: 'a0000000-0000-4000-8000-0000000000a1',
  adult: 'a0000000-0000-4000-8000-0000000000a2',
  teen: 'a0000000-0000-4000-8000-0000000000a3',
  child: 'a0000000-0000-4000-8000-0000000000a4',
  caregiver: 'a0000000-0000-4000-8000-0000000000a5',
  kid: 'a0000000-0000-4000-8000-0000000000a7',
  creator: 'a0000000-0000-4000-8000-0000000000a8',
  other: 'b0000000-0000-4000-8000-0000000000b1',
};

const PLACE_A = 'a0000000-0000-4000-8000-0000000000d1';
const PLACE_B = 'b0000000-0000-4000-8000-0000000000d2';

let db: InMemorySupabase;

function signedInAs(role: Writer, opts: { user?: string; email?: string } = {}) {
  const userId = opts.user ?? USER[role];
  mocks.requireUserContext.mockResolvedValue({
    user: { id: userId, email: opts.email ?? `${role}@example.com` },
    memberships: [],
    active: { familyId: FAMILY_A, family: { id: FAMILY_A, timezone: 'UTC' }, role, member: { id: `member-${userId}` } },
  });
}
const signedInAsKidLogin = () => signedInAs('child', { user: USER.kid, email: `mia@${CHILD_LOGIN_EMAIL_DOMAIN}` });

const rows = (filter: (r: Row) => boolean = () => true) => db.table('dining_out').filter(filter);
const familyB = () => structuredClone(rows((r) => r.family_id === FAMILY_B));

/** The database refusing every write to dining_out the way RLS does: `{ data: null, error }`. */
function refusingWrites() {
  mocks.client = withFaults(db, (table, calls) =>
    table === 'dining_out' && calls.some((c) => ['insert', 'update'].includes(c.method))
      ? { code: '42501', message: 'new row violates row-level security policy for table "dining_out"' }
      : null);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase();
  mocks.client = db;
  db.seed('dining_out', [
    { id: PLACE_A, family_id: FAMILY_A, name: 'Taco Corner', kind: 'restaurant', is_favorite: false, rating: 4, created_by: USER.creator },
    { id: PLACE_B, family_id: FAMILY_B, name: 'Noodle Bar', kind: 'restaurant', is_favorite: false, rating: 3, created_by: USER.other },
  ]);
});

describe('addRestaurantAction', () => {
  it.each(WRITERS)('ACTION-557354D4F82F %s saves one restaurant in household A under their own name', async (role) => {
    signedInAs(role);
    const before = familyB();
    await expect(addRestaurantAction({ name: '  Pho Place ', cuisine: ' Vietnamese ', priceLevel: 2, rating: 5, distanceKm: 1.5 }))
      .resolves.toEqual({ ok: true });
    expect(rows((r) => r.name === 'Pho Place')).toEqual([expect.objectContaining({
      family_id: FAMILY_A, kind: 'restaurant', cuisine: 'Vietnamese', price_level: 2, rating: 5, distance_km: 1.5, created_by: USER[role],
    })]);
    expect(rows()).toHaveLength(3);
    expect(familyB()).toEqual(before);
  });

  it('ACTION-557354D4F82F a kid login saves a restaurant under its own name', async () => {
    signedInAsKidLogin();
    await expect(addRestaurantAction({ name: 'Pizza Spot' })).resolves.toEqual({ ok: true });
    expect(rows((r) => r.name === 'Pizza Spot')).toEqual([expect.objectContaining({ family_id: FAMILY_A, created_by: USER.kid })]);
  });

  it('ACTION-557354D4F82F out-of-range price and rating are dropped, a one-letter name is refused', async () => {
    signedInAs('parent');
    await expect(addRestaurantAction({ name: 'Diner', priceLevel: 9, rating: 7 })).resolves.toEqual({ ok: true });
    expect(rows((r) => r.name === 'Diner')[0]).toMatchObject({ price_level: null, rating: null });
    await expect(addRestaurantAction({ name: 'X' })).resolves.toEqual({ ok: false, error: 'actions.giveThePlaceAName' });
    expect(rows()).toHaveLength(3);
  });

  it('ACTION-557354D4F82F a write the database refuses is reported, not answered ok', async () => {
    signedInAs('child');
    refusingWrites();
    const result = await addRestaurantAction({ name: 'Pho Place' });
    expect(result.ok).toBe(false);
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/permission/i) });
    expect(rows()).toHaveLength(2);
  });

  it('ACTION-557354D4F82F a signed-out caller is sent to login and nothing is written', async () => {
    mocks.requireUserContext.mockRejectedValue(new Error('NEXT_REDIRECT:/login'));
    await expect(addRestaurantAction({ name: 'Pho Place' })).rejects.toThrow('NEXT_REDIRECT');
    expect(rows()).toHaveLength(2);
  });
});

describe('logVisitAction', () => {
  it.each(WRITERS)('ACTION-885920C91B68 %s logs one visit in household A under their own name', async (role) => {
    signedInAs(role);
    const before = familyB();
    await expect(logVisitAction({ name: 'Taco Corner', amountCents: 4250.4, itemCount: 3, visitedAt: '2026-11-01T19:00:00.000Z' }))
      .resolves.toEqual({ ok: true });
    expect(rows((r) => r.kind === 'visit')).toEqual([expect.objectContaining({
      family_id: FAMILY_A, name: 'Taco Corner', amount_cents: 4250, item_count: 3, visited_at: '2026-11-01T19:00:00.000Z', created_by: USER[role],
    })]);
    expect(familyB()).toEqual(before);
  });

  it('ACTION-885920C91B68 a kid login logs a visit under its own name', async () => {
    signedInAsKidLogin();
    await expect(logVisitAction({ name: 'Taco Corner' })).resolves.toEqual({ ok: true });
    expect(rows((r) => r.kind === 'visit')).toEqual([expect.objectContaining({ family_id: FAMILY_A, created_by: USER.kid, amount_cents: null })]);
  });

  it('ACTION-885920C91B68 a negative amount is dropped and a nameless visit is refused', async () => {
    signedInAs('adult');
    await expect(logVisitAction({ name: 'Taco Corner', amountCents: -10 })).resolves.toEqual({ ok: true });
    expect(rows((r) => r.kind === 'visit')[0]).toMatchObject({ amount_cents: null });
    await expect(logVisitAction({ name: ' ' })).resolves.toEqual({ ok: false, error: 'actions.whichRestaurantWasIt' });
    expect(rows((r) => r.kind === 'visit')).toHaveLength(1);
  });

  it('ACTION-885920C91B68 a write the database refuses is reported, not answered ok', async () => {
    signedInAs('teen');
    refusingWrites();
    const result = await logVisitAction({ name: 'Taco Corner' });
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/permission/i) });
    expect(rows((r) => r.kind === 'visit')).toEqual([]);
  });

  it('ACTION-885920C91B68 a signed-out caller is sent to login and nothing is written', async () => {
    mocks.requireUserContext.mockRejectedValue(new Error('NEXT_REDIRECT:/login'));
    await expect(logVisitAction({ name: 'Taco Corner' })).rejects.toThrow('NEXT_REDIRECT');
    expect(rows()).toHaveLength(2);
  });
});

describe('toggleFavoriteAction', () => {
  it.each(WRITERS)('ACTION-E7BFD9F7072B %s hearts a place another member saved, and only is_favorite changes', async (role) => {
    signedInAs(role);
    const before = structuredClone(rows((r) => r.id === PLACE_A)[0]);
    const b = familyB();
    await expect(toggleFavoriteAction(PLACE_A, true)).resolves.toEqual({ ok: true });
    expect(rows((r) => r.id === PLACE_A)[0]).toEqual({ ...before, is_favorite: true });
    expect(familyB()).toEqual(b);

    await expect(toggleFavoriteAction(PLACE_A, false)).resolves.toEqual({ ok: true });
    expect(rows((r) => r.id === PLACE_A)[0]).toEqual(before);
  });

  it('ACTION-E7BFD9F7072B a kid login hearts a place', async () => {
    signedInAsKidLogin();
    await expect(toggleFavoriteAction(PLACE_A, true)).resolves.toEqual({ ok: true });
    expect(rows((r) => r.id === PLACE_A)[0]?.is_favorite).toBe(true);
  });

  it.each(WRITERS)('ACTION-E7BFD9F7072B %s cannot heart household B\'s place by its id, and nothing changes', async (role) => {
    signedInAs(role);
    const before = structuredClone(rows());
    await expect(toggleFavoriteAction(PLACE_B, true)).resolves.toEqual({ ok: false, error: 'actions.couldNotUpdateThatRestaurant' });
    expect(rows()).toEqual(before);
  });

  it('ACTION-E7BFD9F7072B an id that matches nothing is not answered ok', async () => {
    signedInAs('parent');
    await expect(toggleFavoriteAction('a0000000-0000-4000-8000-0000000000ff', true))
      .resolves.toEqual({ ok: false, error: 'actions.couldNotUpdateThatRestaurant' });
  });

  it('ACTION-E7BFD9F7072B a write the database refuses is reported, and the heart is not kept', async () => {
    signedInAs('caregiver');
    refusingWrites();
    const result = await toggleFavoriteAction(PLACE_A, true);
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/permission/i) });
    expect(rows((r) => r.id === PLACE_A)[0]?.is_favorite).toBe(false);
  });

  it('ACTION-E7BFD9F7072B a signed-out caller is sent to login and nothing changes', async () => {
    mocks.requireUserContext.mockRejectedValue(new Error('NEXT_REDIRECT:/login'));
    await expect(toggleFavoriteAction(PLACE_A, true)).rejects.toThrow('NEXT_REDIRECT');
    expect(rows((r) => r.id === PLACE_A)[0]?.is_favorite).toBe(false);
  });
});
