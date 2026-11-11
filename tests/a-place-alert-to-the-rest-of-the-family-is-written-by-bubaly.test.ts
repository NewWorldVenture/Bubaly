// LIBRARY-DD1CEA81A9DE: a geofence alert is addressed to everyone BUT the
// mover, and 0388 lets a member's session insert a notification only for
// itself (user_id = auth.uid()). updateMyLocation built its "system" scope
// around the mover's own cookie-session client, and notify() writes a system
// scope's rows through the client the scope carries, so the whole batch was
// refused by RLS and "Ella left Home" was never written, only logged.
//
// Driven through the real action, the real scope builder and the real notify()
// against the in-memory database. The member's session client refuses a
// notification row addressed to anyone else, the way 0388 does; the service
// client does not.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';

const C = vi.hoisted(() => ({ FAMILY: '11111111-1111-4111-8111-111111111111', HOME: '44444444-4444-4444-8444-444444444444' }));
const seam = vi.hoisted(() => ({ session: vi.fn(), service: vi.fn(), mover: { id: 'ella', display_name: 'Ella', role: 'child' } }));
vi.mock('@/lib/supabase/server', () => ({ createServer: seam.session, createServiceClient: seam.service }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: `u-${seam.mover.id}`, email: null }, memberships: [],
    active: { familyId: C.FAMILY, role: seam.mover.role, family: { id: C.FAMILY, timezone: 'UTC' }, member: { id: seam.mover.id, family_id: C.FAMILY, display_name: seam.mover.display_name } },
  }),
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { updateMyLocation } = await import('@/app/(app)/dashboard/locator/actions');
const AT_HOME = { latitude: 40.0, longitude: -74.0 };
const FAR = { latitude: 41.0, longitude: -75.0 };
let db: InMemorySupabase;

/** The member's session: 0388 refuses a notification addressed to anyone else. */
function sessionClientFor(userId: string) {
  return withFaults(db, (table, calls) => {
    if (table !== 'notifications') return null;
    const insert = calls.find((c) => c.method === 'insert');
    if (!insert) return null;
    const rows = [insert.args[0]].flat() as { user_id?: string | null }[];
    return rows.every((r) => r.user_id === userId)
      ? null
      : { code: '42501', message: 'new row violates row-level security policy for table "notifications"' };
  });
}

beforeEach(() => {
  db = createInMemorySupabase();
  db.seed('families', [{ id: C.FAMILY, name: 'Fixture', timezone: 'UTC' }]);
  db.seed('family_members', [
    { id: 'mum', role: 'parent' }, { id: 'gran', role: 'adult' }, { id: 'ella', role: 'child' },
  ].map((m) => ({ ...m, family_id: C.FAMILY, user_id: `u-${m.id}`, display_name: m.id, is_active: true })));
  db.seed('family_places', [{ id: C.HOME, family_id: C.FAMILY, name: 'Home', ...AT_HOME, radius_m: 150, geofence_enabled: true }]);
  seam.session.mockImplementation(async () => sessionClientFor(`u-${seam.mover.id}`));
  seam.service.mockImplementation(() => db);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('a place alert to the rest of the family is written by Bubaly, not by the mover\'s session', () => {
  it('a child leaving Home leaves an urgent alert in each manager\'s list', async () => {
    seam.mover = { id: 'ella', display_name: 'Ella', role: 'child' };
    db.seed('member_locations', [{ family_id: C.FAMILY, member_id: 'ella', place_id: C.HOME, is_sharing: true, ...AT_HOME }]);

    expect(await updateMyLocation(FAR)).toEqual({ ok: true, place: null });

    const written = db.table('notifications');
    expect(written.map((n) => n.user_id).sort()).toEqual(['u-gran', 'u-mum']);
    for (const row of written) {
      expect(row).toMatchObject({ family_id: C.FAMILY, title: 'Ella left Home', related_type: 'location_events' });
    }
    // Nothing was dropped on the floor and only logged.
    expect(console.error).not.toHaveBeenCalled();
  });

  it('a parent arriving at Home is told to the other manager, and never to themselves', async () => {
    seam.mover = { id: 'mum', display_name: 'Mum', role: 'parent' };

    expect(await updateMyLocation(AT_HOME)).toEqual({ ok: true, place: 'Home' });

    expect(db.table('notifications').map((n) => [n.user_id, n.title])).toEqual([['u-gran', 'Mum arrived at Home']]);
  });

  it('the mover\'s own writes still go through their own session', async () => {
    seam.mover = { id: 'ella', display_name: 'Ella', role: 'child' };

    expect(await updateMyLocation(AT_HOME)).toEqual({ ok: true, place: 'Home' });

    // The position and the timeline are the member's own rows, written on
    // their own session; the service client is only for the alert.
    expect(seam.session).toHaveBeenCalled();
    expect(db.table('member_locations')).toEqual([expect.objectContaining({ member_id: 'ella', place_id: C.HOME })]);
    expect(db.table('location_events')).toEqual([expect.objectContaining({ member_id: 'ella', event_type: 'arrived' })]);
  });
});
