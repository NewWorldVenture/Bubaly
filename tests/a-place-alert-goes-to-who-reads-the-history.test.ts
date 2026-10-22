// A6 — geofence arrive/leave alerts went to every member with a login.
//
// updateMyLocation addressed "<member> arrived at <place>" to everyone but the
// mover, so a guest — whom 0481 refuses other members' positions and the
// family's places — and a child were pushed "Mum left Home" with the place's
// name. Who reads other members' movements is the owner's rule in
// lib/location/history-scope.ts (managers and caregivers), the rule the
// locator page applies; the alert now follows it.
//
// Driven through the real action against the in-memory database; notify() is
// the seam that would push.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const C = vi.hoisted(() => ({ FAMILY: '11111111-1111-4111-8111-111111111111', HOME: '44444444-4444-4444-8444-444444444444' }));
const seam = vi.hoisted(() => ({ server: vi.fn(), notify: vi.fn(), mover: { id: 'mum', display_name: 'Mum', role: 'parent' } }));
vi.mock('@/lib/supabase/server', () => ({ createServer: seam.server, createServiceClient: seam.server }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: `u-${seam.mover.id}`, email: null }, memberships: [],
    active: { familyId: C.FAMILY, role: seam.mover.role, family: { id: C.FAMILY, timezone: 'UTC' }, member: { id: seam.mover.id, family_id: C.FAMILY, display_name: seam.mover.display_name } },
  }),
}));
vi.mock('@/lib/services/notifications', () => ({ notify: seam.notify }));
vi.mock('@/lib/services/scope', () => ({ systemScopeForFamily: async () => ({ familyId: C.FAMILY, tz: 'UTC' }) }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { updateMyLocation } = await import('@/app/(app)/dashboard/locator/actions');
const AT_HOME = { latitude: 40.0, longitude: -74.0 };
const FAR = { latitude: 41.0, longitude: -75.0 };
let db: InMemorySupabase;

const ROSTER = [
  { id: 'mum', role: 'parent' }, { id: 'gran', role: 'adult' }, { id: 'nanny', role: 'caregiver' },
  { id: 'sam', role: 'teen' }, { id: 'ella', role: 'child' }, { id: 'aunt', role: 'guest' },
];
const addressed = () => [...(seam.notify.mock.calls.at(-1)?.[1].recipients as string[])].sort();

beforeEach(() => {
  db = createInMemorySupabase();
  db.seed('families', [{ id: C.FAMILY, name: 'Fixture', timezone: 'UTC' }]);
  db.seed('family_members', [
    ...ROSTER.map((m) => ({ ...m, family_id: C.FAMILY, user_id: `u-${m.id}`, display_name: m.id, is_active: true })),
    // A member without a login is never addressed either way.
    { id: 'baby', family_id: C.FAMILY, user_id: null, display_name: 'baby', role: 'child', is_active: true },
  ]);
  db.seed('family_places', [{ id: C.HOME, family_id: C.FAMILY, name: 'Home', ...AT_HOME, radius_m: 150, geofence_enabled: true }]);
  seam.server.mockImplementation(async () => db);
  seam.notify.mockReset().mockResolvedValue({ ok: true, data: { created: 1, duplicates: 0, ids: [], skippedMemberIds: [], deferred: 0 } });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('a place alert reaches the members who read everyone\'s location history', () => {
  it('a parent leaving Home is told to the other managers and the caregiver — not the teen, the child or the guest', async () => {
    seam.mover = { id: 'mum', display_name: 'Mum', role: 'parent' };
    db.seed('member_locations', [{ family_id: C.FAMILY, member_id: 'mum', place_id: C.HOME, is_sharing: true, ...AT_HOME }]);
    expect(await updateMyLocation(FAR)).toEqual({ ok: true, place: null });
    expect(seam.notify).toHaveBeenCalledOnce();
    expect(seam.notify.mock.calls[0][1]).toMatchObject({ title: 'Mum left Home', urgent: true });
    expect(addressed()).toEqual(['gran', 'nanny']);
  });

  it('a child arriving at Home is told to the managers and the caregiver, and never to the guest', async () => {
    seam.mover = { id: 'ella', display_name: 'Ella', role: 'child' };
    expect(await updateMyLocation(AT_HOME)).toEqual({ ok: true, place: 'Home' });
    expect(seam.notify.mock.calls[0][1]).toMatchObject({ title: 'Ella arrived at Home' });
    expect(addressed()).toEqual(['gran', 'mum', 'nanny']);
    expect(addressed()).not.toContain('aunt');
    expect(addressed()).not.toContain('sam');
  });

  it('a family with no one else who reads the history sends nothing', async () => {
    db.replace('family_members', [
      { id: 'mum', family_id: C.FAMILY, user_id: 'u-mum', display_name: 'mum', role: 'parent', is_active: true },
      { id: 'aunt', family_id: C.FAMILY, user_id: 'u-aunt', display_name: 'aunt', role: 'guest', is_active: true },
      { id: 'ella', family_id: C.FAMILY, user_id: 'u-ella', display_name: 'ella', role: 'child', is_active: true },
    ]);
    seam.mover = { id: 'mum', display_name: 'Mum', role: 'parent' };
    expect(await updateMyLocation(AT_HOME)).toEqual({ ok: true, place: 'Home' });
    expect(seam.notify).not.toHaveBeenCalled();
    // The timeline still records the arrival.
    expect(db.table('location_events')).toEqual([expect.objectContaining({ member_id: 'mum', event_type: 'arrived' })]);
  });
});
