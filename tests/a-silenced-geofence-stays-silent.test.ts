// The geofence switch has to switch the geofence off.
//
// setGeofenceEnabled writes family_places.geofence_enabled and the Geofences
// rail shows the switch as off. updateMyLocation then read every family place
// without looking at the flag, so a disabled place still matched: a
// location_events row was written and an urgent "<member> arrived at <place>"
// went to every other member, while the UI said the geofence was off.
//
// Beside it, the two reads that decide an alert both dropped their errors. A
// failed family_places read left `places` null, so a child sitting at Home was
// classified as having LEFT it (prev=Home, current=null): a false urgent
// "left Home" to the whole family, and a false "arrived" on the next good read.
// A failed member_locations read made `prev` null, so a member already inside
// a geofence was announced as newly arrived.
//
// And a location_events row stored the poster's exact coordinates for ever
// (0335 forbids clients to delete them; "Stop Sharing" left them, and left
// accuracy, battery and address on the live row too), though the timeline only
// ever reads place, event and time.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const C = vi.hoisted(() => ({
  FAMILY: '11111111-1111-4111-8111-111111111111',
  KID: '22222222-2222-4222-8222-222222222222',
  PARENT: '33333333-3333-4333-8333-333333333333',
  HOME: '44444444-4444-4444-8444-444444444444',
}));
const seam = vi.hoisted(() => ({ server: vi.fn(), notify: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServer: seam.server, createServiceClient: seam.server }));
vi.mock('@/lib/supabase/auth', () => ({
  // The child posts their own location.
  requireUserContext: async () => ({
    user: { id: 'u-kid', email: null }, memberships: [],
    active: { familyId: C.FAMILY, role: 'child', family: { id: C.FAMILY, timezone: 'UTC' }, member: { id: C.KID, family_id: C.FAMILY, display_name: 'Kid' } },
  }),
}));
vi.mock('@/lib/services/notifications', () => ({ notify: seam.notify }));
vi.mock('@/lib/services/scope', () => ({ systemScopeForFamily: async () => ({ familyId: C.FAMILY, tz: 'UTC' }) }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const AT_HOME = { latitude: 40.0, longitude: -74.0 };
const FAR_AWAY = { latitude: 41.0, longitude: -75.0 };

let db: InMemorySupabase;
let errors: unknown[][];

/** One table answers every call with a RESOLVED error, the way PostgREST does. */
function refuse(client: InMemorySupabase, table: string): void {
  const before = client.from.bind(client);
  const reply = { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' }, count: null, status: 503, statusText: 'Service Unavailable' };
  const chain: Record<string | symbol, unknown> = new Proxy({}, {
    get(_target, prop) {
      if (prop === 'then') return (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(reply).then(resolve, reject);
      return () => chain;
    },
  });
  client.from = ((name: string) => (name === table ? chain : before(name))) as InMemorySupabase['from'];
}

const home = (geofence_enabled: boolean) => ({ id: C.HOME, family_id: C.FAMILY, name: 'Home', ...AT_HOME, radius_m: 150, geofence_enabled });
const liveRow = () => db.table('member_locations').find((row) => row.member_id === C.KID);

beforeEach(() => {
  db = createInMemorySupabase();
  db.seed('families', [{ id: C.FAMILY, name: 'Fixture', timezone: 'UTC' }]);
  db.seed('family_members', [
    { id: C.KID, family_id: C.FAMILY, user_id: 'u-kid', display_name: 'Kid', is_active: true, role: 'child' },
    { id: C.PARENT, family_id: C.FAMILY, user_id: 'u-parent', display_name: 'Ada', is_active: true, role: 'parent' },
  ]);
  errors = [];
  seam.server.mockImplementation(async () => db);
  seam.notify.mockReset();
  seam.notify.mockResolvedValue({ ok: true, data: { created: 1, duplicates: 0, ids: [], skippedMemberIds: [], deferred: 0 } });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args); });
});
afterEach(() => { vi.restoreAllMocks(); });

describe('a geofence a parent switched off', () => {
  it('does not match, log an event or alert the family when the member walks into it', async () => {
    db.seed('family_places', [home(false)]);
    const { updateMyLocation } = await import('@/app/(app)/dashboard/locator/actions');
    const result = await updateMyLocation(AT_HOME);
    expect(result).toEqual({ ok: true, place: null });
    // The defect: an 'arrived' row and an urgent "Kid arrived at Home" to Ada.
    expect(db.table('location_events')).toEqual([]);
    expect(seam.notify).not.toHaveBeenCalled();
    expect(liveRow()).toMatchObject({ member_id: C.KID, place_id: null, is_sharing: true, ...AT_HOME });
  });

  it('does not announce the member "leaving" it either, once it is off while they are inside', async () => {
    db.seed('family_places', [home(false)]);
    db.seed('member_locations', [{ family_id: C.FAMILY, member_id: C.KID, place_id: C.HOME, is_sharing: true, ...AT_HOME }]);
    const { updateMyLocation } = await import('@/app/(app)/dashboard/locator/actions');
    expect(await updateMyLocation(FAR_AWAY)).toEqual({ ok: true, place: null });
    expect(db.table('location_events')).toEqual([]);
    expect(seam.notify).not.toHaveBeenCalled();
  });

  it('an armed one still fires (positive control), and the event carries no coordinates', async () => {
    db.seed('family_places', [home(true)]);
    const { updateMyLocation } = await import('@/app/(app)/dashboard/locator/actions');
    expect(await updateMyLocation(AT_HOME)).toEqual({ ok: true, place: 'Home' });
    const events = db.table('location_events');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ family_id: C.FAMILY, member_id: C.KID, place_id: C.HOME, place_name: 'Home', event_type: 'arrived' });
    // The timeline reads place, event and time. Exact coordinates were a
    // permanent position history nobody could delete.
    expect(events[0]).not.toHaveProperty('latitude');
    expect(events[0]).not.toHaveProperty('longitude');
    expect(seam.notify).toHaveBeenCalledOnce();
    expect(seam.notify.mock.calls[0][1]).toMatchObject({ recipients: [C.PARENT], title: 'Kid arrived at Home', urgent: true });
    expect(liveRow()).toMatchObject({ place_id: C.HOME });
  });
});

describe('a read that decides an alert and failed', () => {
  it('a failed geofence read is refused, not read as "no places" — no false "left Home"', async () => {
    db.seed('family_places', [home(true)]);
    db.seed('member_locations', [{ family_id: C.FAMILY, member_id: C.KID, place_id: C.HOME, is_sharing: true, ...AT_HOME }]);
    refuse(db, 'family_places');
    const { updateMyLocation } = await import('@/app/(app)/dashboard/locator/actions');
    const result = await updateMyLocation(AT_HOME);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    // The defect: prev=Home, current=null → 'left' → an urgent "Kid left Home"
    // to the whole family while the child was still at home.
    expect(db.table('location_events')).toEqual([]);
    expect(seam.notify).not.toHaveBeenCalled();
    expect(liveRow(), 'the live row is not rewritten off a failed read').toMatchObject({ place_id: C.HOME });
  });

  it('a failed previous-place read is refused, not read as "was nowhere" — no false "arrived"', async () => {
    db.seed('family_places', [home(true)]);
    db.seed('member_locations', [{ family_id: C.FAMILY, member_id: C.KID, place_id: C.HOME, is_sharing: true, ...AT_HOME }]);
    refuse(db, 'member_locations');
    const { updateMyLocation } = await import('@/app/(app)/dashboard/locator/actions');
    expect((await updateMyLocation(AT_HOME)).ok).toBe(false);
    expect(db.table('location_events')).toEqual([]);
    expect(seam.notify).not.toHaveBeenCalled();
  });
});

describe('Stop Sharing', () => {
  it('clears everything the live row says about where the member is', async () => {
    db.seed('member_locations', [{
      family_id: C.FAMILY, member_id: C.KID, is_sharing: true, ...AT_HOME, place_id: C.HOME,
      address: '1 Main St', accuracy_m: 5, battery: 80,
    }]);
    const { setLocationSharing } = await import('@/app/(app)/dashboard/locator/actions');
    expect(await setLocationSharing(false)).toEqual({ ok: true });
    // accuracy_m, battery and address used to stay behind.
    expect(liveRow()).toMatchObject({
      is_sharing: false, latitude: null, longitude: null, place_id: null, address: null, accuracy_m: null, battery: null,
    });
  });
});
