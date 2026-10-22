// N7 — turning location sharing back on announced an arrival that never
// happened.
//
// Stop Sharing clears the live row's place (CLEARED_POSITION), so the next
// share at Home was classified null -> Home: an 'arrived' row on the safety
// timeline and an URGENT "Mum arrived at Home" push to every manager and
// caregiver, for someone who had been at home all evening. The same for a
// geofence a parent re-armed with the member already inside it: the place was
// left off the live row while the switch was off, so the next post "arrived".
//
// The REAL updateMyLocation and setLocationSharing against an in-memory
// database; notify() is the seam that would push.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const C = vi.hoisted(() => ({ FAMILY: '11111111-1111-4111-8111-111111111111', HOME: '44444444-4444-4444-8444-444444444444' }));
const seam = vi.hoisted(() => ({ server: vi.fn(), notify: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServer: seam.server, createServiceClient: seam.server }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'u-mum', email: null }, memberships: [],
    active: { familyId: C.FAMILY, role: 'parent', family: { id: C.FAMILY, timezone: 'UTC' }, member: { id: 'mum', family_id: C.FAMILY, display_name: 'Mum' } },
  }),
}));
vi.mock('@/lib/services/notifications', () => ({ notify: seam.notify }));
vi.mock('@/lib/services/scope', () => ({ systemScopeForFamily: async () => ({ familyId: C.FAMILY, tz: 'UTC' }) }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { updateMyLocation, setLocationSharing } = await import('@/app/(app)/dashboard/locator/actions');
const AT_HOME = { latitude: 40.0, longitude: -74.0 };
const FAR = { latitude: 41.0, longitude: -75.0 };
let db: InMemorySupabase;

const home = () => db.table('family_places').find((p) => p.id === C.HOME)!;
const live = () => db.table('member_locations').find((r) => r.member_id === 'mum');

beforeEach(() => {
  db = createInMemorySupabase();
  db.seed('families', [{ id: C.FAMILY, name: 'Fixture', timezone: 'UTC' }]);
  db.seed('family_members', [
    { id: 'mum', family_id: C.FAMILY, user_id: 'u-mum', display_name: 'Mum', role: 'parent', is_active: true },
    { id: 'dad', family_id: C.FAMILY, user_id: 'u-dad', display_name: 'Dad', role: 'parent', is_active: true },
  ]);
  db.seed('family_places', [{ id: C.HOME, family_id: C.FAMILY, name: 'Home', ...AT_HOME, radius_m: 150, geofence_enabled: true }]);
  seam.server.mockImplementation(async () => db);
  seam.notify.mockReset().mockResolvedValue({ ok: true, data: { created: 1, duplicates: 0, ids: [], skippedMemberIds: [], deferred: 0 } });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('a share after sharing was off is a baseline, not an arrival', () => {
  it('Mum, home all evening, turns sharing off and on: nothing is logged and nobody is pushed', async () => {
    db.seed('member_locations', [{ family_id: C.FAMILY, member_id: 'mum', place_id: C.HOME, is_sharing: true, ...AT_HOME }]);
    expect(await setLocationSharing(false)).toEqual({ ok: true });
    expect(live()).toMatchObject({ is_sharing: false, place_id: null });

    expect(await updateMyLocation(AT_HOME)).toEqual({ ok: true, place: 'Home' });

    expect(db.table('location_events')).toEqual([]);
    expect(seam.notify).not.toHaveBeenCalled();
    // The live row is where she is, all the same.
    expect(live()).toMatchObject({ is_sharing: true, place_id: C.HOME, ...AT_HOME });
  });

  it('a row that is sharing but has no position yet is a baseline too', async () => {
    db.seed('member_locations', [{ family_id: C.FAMILY, member_id: 'mum', place_id: null, is_sharing: true, latitude: null, longitude: null }]);
    await updateMyLocation(AT_HOME);
    expect(db.table('location_events')).toEqual([]);
    expect(seam.notify).not.toHaveBeenCalled();
  });

  it('a geofence re-armed with the member already inside it is not an arrival', async () => {
    db.seed('member_locations', [{ family_id: C.FAMILY, member_id: 'mum', place_id: C.HOME, is_sharing: true, ...AT_HOME }]);
    // A parent switches Home off; Mum's phone posts from home meanwhile.
    home().geofence_enabled = false;
    await updateMyLocation(AT_HOME);
    expect(live()).toMatchObject({ place_id: null });
    // Switched back on. Mum has not moved.
    home().geofence_enabled = true;
    expect(await updateMyLocation(AT_HOME)).toEqual({ ok: true, place: 'Home' });
    expect(db.table('location_events')).toEqual([]);
    expect(seam.notify).not.toHaveBeenCalled();
  });

  it('a real arrival from a shared position elsewhere is still announced (positive control)', async () => {
    db.seed('member_locations', [{ family_id: C.FAMILY, member_id: 'mum', place_id: null, is_sharing: true, ...FAR }]);
    expect(await updateMyLocation(AT_HOME)).toEqual({ ok: true, place: 'Home' });
    expect(db.table('location_events')).toEqual([expect.objectContaining({ member_id: 'mum', event_type: 'arrived', place_name: 'Home' })]);
    expect(seam.notify).toHaveBeenCalledOnce();
    expect(seam.notify.mock.calls[0][1]).toMatchObject({ title: 'Mum arrived at Home', recipients: ['dad'], urgent: true });
  });

  it('a real departure after sharing resumed is still announced', async () => {
    db.seed('member_locations', [{ family_id: C.FAMILY, member_id: 'mum', place_id: C.HOME, is_sharing: true, ...AT_HOME }]);
    await setLocationSharing(false);
    await updateMyLocation(AT_HOME); // the baseline
    expect(await updateMyLocation(FAR)).toEqual({ ok: true, place: null });
    expect(db.table('location_events')).toEqual([expect.objectContaining({ event_type: 'left', place_name: 'Home' })]);
    expect(seam.notify.mock.calls[0][1]).toMatchObject({ title: 'Mum left Home' });
  });
});
