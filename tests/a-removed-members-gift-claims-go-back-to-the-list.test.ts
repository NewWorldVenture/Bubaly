// N12 — a gift claimed by a member who is then removed could never be
// released. Removal is a soft delete (REMOVED_MEMBER_PATCH), so the ON DELETE
// SET NULL on wishlist_items.claimed_by never fires, and 0481's
// wishlist_item_write_guard refuses any claim change unless the caller IS the
// claimer (is_self_member, which a removed member no longer passes): a parent's
// release and another giver's claim both raise 42501 "this gift is claimed by
// someone else". The wish showed "Claimed" to every remaining giver for good.
// Both removal paths now release the removed member's claims with the service
// role, the way the hard delete's SET NULL would have.
//
// N12-purchased: round 1's release also cleared is_purchased, which the hard
// delete's SET NULL (wishlist_items_claimed_by_fkey) keeps. A gift the removed
// member had already bought went back on the list as 'unclaimed' and could be
// bought a second time. The release now clears the claimer and keeps
// is_purchased: a bought gift still reads 'purchased', an unbought claim goes
// back on the list.
//
// Driven through the real removal actions against the in-memory database.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';
import { claimState, canToggleClaim, type WishLike } from '@/lib/wishlists/gifts';

const C = vi.hoisted(() => ({
  FAMILY: '11111111-1111-4111-8111-1111111111aa',
  OTHER_FAMILY: '22222222-2222-4222-8222-2222222222aa',
  CARER: '33333333-3333-4333-8333-3333333333aa',
  KID: '44444444-4444-4444-8444-4444444444aa',
  SIB: '55555555-5555-4555-8555-5555555555aa',
  MANAGER: '66666666-6666-4666-8666-6666666666aa',
}));
const seam = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => seam.db, createServer: async () => seam.db }));
vi.mock('@/lib/supabase/auth', () => ({
  getUser: async () => ({ id: 'u-admin', email: 'admin@example.test' }),
  isSuperAdmin: async () => true,
  requireUserContext: async () => ({
    user: { id: 'u-manager', email: null }, memberships: [],
    active: { familyId: C.FAMILY, role: 'parent', family: { id: C.FAMILY, timezone: 'UTC' }, member: { id: C.MANAGER, family_id: C.FAMILY, display_name: 'Ada' } },
  }),
}));
vi.mock('@/lib/server/audit', () => ({ logAudit: async () => {} }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn }));

const { removeFamilyMemberAction } = await import('@/app/(app)/family/member-actions');
const { adminRemoveMemberAction } = await import('@/app/(app)/admin/actions');

let db: InMemorySupabase;
const wish = (id: string) => db.table('wishlist_items').find((row) => row.id === id) as unknown as WishLike & { claimed_at: string | null };

beforeEach(() => {
  db = createInMemorySupabase({ userId: 'u-manager' });
  // The admin console's step-up check: this session has entered its code.
  Object.assign(db.auth, { getSession: async () => ({ data: { session: { access_token: 'synthetic-assurance-token' } }, error: null }), mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: 'aal2', nextLevel: 'aal2' }, error: null }) } });
  seam.db = db;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db.seed('family_members', [
    { id: C.MANAGER, family_id: C.FAMILY, user_id: 'u-manager', display_name: 'Ada', is_active: true, role: 'parent' },
    { id: C.CARER, family_id: C.FAMILY, user_id: null, display_name: 'Carer', is_active: true, role: 'caregiver', email: null },
    { id: C.KID, family_id: C.FAMILY, user_id: 'u-kid', display_name: 'Kid', is_active: true, role: 'child' },
    { id: C.SIB, family_id: C.FAMILY, user_id: 'u-sib', display_name: 'Sib', is_active: true, role: 'child' },
  ]);
  const claimed = { claimed_at: '2026-10-01T10:00:00Z', priority: 'medium' as const };
  db.seed('wishlist_items', [
    // Sib's wish, claimed (and bought) by the carer about to be removed.
    { id: 'wish-carer', family_id: C.FAMILY, member_id: C.SIB, title: 'Telescope', ...claimed, claimed_by: C.CARER, is_purchased: true },
    // Sib's other wish, claimed by the carer and not bought yet.
    { id: 'wish-carer-unbought', family_id: C.FAMILY, member_id: C.SIB, title: 'Puzzle', ...claimed, claimed_by: C.CARER, is_purchased: false },
    // Controls: another giver's claim in the family, and the same member id's claim elsewhere.
    { id: 'wish-kid', family_id: C.FAMILY, member_id: C.SIB, title: 'Kite', ...claimed, claimed_by: C.KID, is_purchased: false },
    { id: 'wish-elsewhere', family_id: C.OTHER_FAMILY, member_id: 'other-kid', title: 'Bike', ...claimed, claimed_by: C.CARER, is_purchased: false },
  ]);
});
afterEach(() => { vi.restoreAllMocks(); });

const expectReleased = () => {
  // The bought gift: the claimer goes, as the hard delete's SET NULL clears
  // claimed_by, and it stays bought, as SET NULL keeps is_purchased. Another
  // giver reads it as bought, not as a gift still to buy.
  expect(wish('wish-carer')).toMatchObject({ claimed_by: null, claimed_at: null, is_purchased: true });
  expect(claimState(wish('wish-carer'), C.KID)).toBe('purchased');
  // And it is closed: claiming it would let the claim's release reset
  // is_purchased (tests/a-bought-gift-is-not-offered-to-be-claimed-again.test.ts).
  expect(canToggleClaim(wish('wish-carer'), C.KID)).toBe(false);
  // The unbought claim: back on the list, and another giver may claim it.
  expect(wish('wish-carer-unbought')).toMatchObject({ claimed_by: null, claimed_at: null, is_purchased: false });
  expect(claimState(wish('wish-carer-unbought'), C.KID)).toBe('unclaimed');
  expect(canToggleClaim(wish('wish-carer-unbought'), C.KID)).toBe(true);
  // Nothing else moves.
  expect(wish('wish-kid')).toMatchObject({ claimed_by: C.KID });
  expect(wish('wish-elsewhere')).toMatchObject({ claimed_by: C.CARER });
};

describe('removing a member who had claimed a gift', () => {
  it('from the family screen gives the gift back to the list', async () => {
    const result = await removeFamilyMemberAction({ memberId: C.CARER });

    expect(result).toMatchObject({ ok: true });
    expect(db.table('family_members').find((row) => row.id === C.CARER)).toMatchObject({ is_active: false });
    expectReleased();
  });

  it('from the admin console gives the gift back to the list', async () => {
    expect(await adminRemoveMemberAction(C.CARER)).toEqual({ ok: true });
    expectReleased();
  });

  it('still removes the member when the release itself fails, and says so in the log', async () => {
    seam.db = withFaults(db, (table, calls) => (table === 'wishlist_items' && calls.some((c) => c.method === 'update') ? { code: '57014', message: 'canceling statement due to statement timeout' } : null));

    expect(await removeFamilyMemberAction({ memberId: C.CARER })).toMatchObject({ ok: true });
    expect(db.table('family_members').find((row) => row.id === C.CARER)).toMatchObject({ is_active: false });
    expect(console.error).toHaveBeenCalledWith('[family] removed member gift claims were not released', expect.objectContaining({ memberId: C.CARER }));
  });
});

describe('control: the gifts of a member who stays', () => {
  it('are left claimed when someone else is removed', async () => {
    await removeFamilyMemberAction({ memberId: C.SIB });
    expect(wish('wish-carer')).toMatchObject({ claimed_by: C.CARER, is_purchased: true });
    expect(wish('wish-kid')).toMatchObject({ claimed_by: C.KID });
  });
});
