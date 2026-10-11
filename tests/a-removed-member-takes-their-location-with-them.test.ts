// A member who leaves a family takes their position with them.
//
// Removal is a soft delete (family_members.is_active = false) from three
// places: the family screen and the settings screen, which both go through
// removeFamilyMemberAction, and the site admin. None of them touched the
// removed member's member_locations row — still is_sharing,
// with latitude, longitude, accuracy, battery and address — nor their
// location_events (raw lat/lng per event) nor safety_check_ins coordinates.
// The family-scoped SELECT and the realtime publication kept all of it
// readable to whoever remained, and a person who left (an ex-partner, a former
// caregiver) had no way to remove the trail.
//
// And nobody's history was ever shortened: location_events was append-only
// for clients and no job purged it, so every member's exact positions
// accumulated for ever.
//
// And when the forget itself failed (a refused or timed-out service-role
// write), both removal paths returned unqualified success: the screens toasted
// "Member removed", the admin console saw { ok: true }, and nothing ever came
// back for the row — the retention sweep never touched member_locations, so a
// removed member's live position stayed on the family map for good. Now the
// removal says so (a warning, like the one for a PIN login that could not be
// signed out), and the daily sweep blanks any live row whose member is no
// longer active.
import { existsSync, readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { at } from './helpers/source-order';

const C = vi.hoisted(() => ({
  FAMILY: '11111111-1111-4111-8111-111111111111',
  OTHER_FAMILY: '22222222-2222-4222-8222-222222222222',
  NANNY: '33333333-3333-4333-8333-333333333333',
  KID: '44444444-4444-4444-8444-444444444444',
  STRANGER: '55555555-5555-4555-8555-555555555555',
  MANAGER: '66666666-6666-4666-8666-666666666666',
}));
const seam = vi.hoisted(() => ({ db: vi.fn(), role: 'parent' as string, audits: [] as unknown[] }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: seam.db, createServer: seam.db }));
vi.mock('@/lib/supabase/auth', () => ({
  getUser: async () => ({ id: 'u-admin', email: 'admin@example.test' }),
  isSuperAdmin: async () => true,
  requireUserContext: async () => ({
    user: { id: 'u-manager', email: null }, memberships: [],
    active: { familyId: C.FAMILY, role: seam.role, family: { id: C.FAMILY, timezone: 'UTC' }, member: { id: C.MANAGER, family_id: C.FAMILY, display_name: 'Ada' } },
  }),
}));
vi.mock('@/lib/server/audit', () => ({ logAudit: async (_db: unknown, entry: unknown) => { seam.audits.push(entry); } }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn }));

const POSITION = { latitude: 40.0, longitude: -74.0 };
const CLEARED = { is_sharing: false, latitude: null, longitude: null, address: null, accuracy_m: null, battery: null, place_id: null };
const DAY = 24 * 60 * 60 * 1000;

let db: InMemorySupabase;
const live = (memberId: string) => db.table('member_locations').find((row) => row.member_id === memberId);

/** member_locations refuses every write (and read), the way a refused or timed-out service-role statement resolves. */
function refuseLocationTable(client: InMemorySupabase): () => void {
  const before = client.from.bind(client);
  const reply = { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' }, count: null, status: 503, statusText: 'Service Unavailable' };
  const chain: Record<string | symbol, unknown> = new Proxy({}, {
    get(_target, prop) {
      if (prop === 'then') return (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(reply).then(resolve, reject);
      return () => chain;
    },
  });
  client.from = ((name: string) => (name === 'member_locations' ? chain : before(name))) as InMemorySupabase['from'];
  return () => { client.from = before; };
}
const events = (memberId: string) => db.table('location_events').filter((row) => row.member_id === memberId);
const checkIns = (memberId: string) => db.table('safety_check_ins').filter((row) => row.member_id === memberId);

/** Two members with a position each; the second is the control that must not be touched. */
function household(nannyActive: boolean) {
  db.seed('family_members', [
    { id: C.NANNY, family_id: C.FAMILY, display_name: 'Nanny', is_active: nannyActive, role: 'caregiver' },
    { id: C.KID, family_id: C.FAMILY, display_name: 'Kid', is_active: true, role: 'child' },
    { id: C.MANAGER, family_id: C.FAMILY, display_name: 'Ada', is_active: true, role: 'parent' },
    { id: C.STRANGER, family_id: C.OTHER_FAMILY, display_name: 'Stranger', is_active: false, role: 'adult' },
  ]);
  for (const [member, family] of [[C.NANNY, C.FAMILY], [C.KID, C.FAMILY], [C.STRANGER, C.OTHER_FAMILY]] as const) {
    db.seed('member_locations', [{ family_id: family, member_id: member, is_sharing: true, ...POSITION, address: '1 Main St', accuracy_m: 5, battery: 80, place_id: 'home' }]);
    db.seed('location_events', [{ id: `e-${member}`, family_id: family, member_id: member, ...POSITION, event_type: 'arrived', place_id: 'home', place_name: 'Home', occurred_at: new Date().toISOString() }]);
    db.seed('safety_check_ins', [{ id: `c-${member}`, family_id: family, member_id: member, ...POSITION, created_at: new Date().toISOString() }]);
  }
}

beforeEach(() => {
  db = createInMemorySupabase();
  // The admin console's actions ask the signed-in session for its assurance
  // level before acting (a password-only session of an admin with an
  // authenticator is refused): this one has entered its code.
  Object.assign(db.auth, { mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: 'aal2', nextLevel: 'aal2' }, error: null }) } });
  seam.db.mockImplementation(() => db);
  seam.role = 'parent';
  seam.audits.length = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe('the site admin removing a member', () => {
  it('blanks their live position and the coordinates on their history, and nobody else\'s', async () => {
    household(true);
    const { adminRemoveMemberAction } = await import('@/app/(app)/admin/actions');
    expect(await adminRemoveMemberAction(C.NANNY)).toEqual({ ok: true });
    expect(db.table('family_members').find((row) => row.id === C.NANNY)).toMatchObject({ is_active: false });
    // The defect: all of this stayed exactly as it was.
    expect(live(C.NANNY)).toMatchObject(CLEARED);
    expect(events(C.NANNY)).toEqual([expect.objectContaining({ latitude: null, longitude: null, place_name: 'Home', event_type: 'arrived' })]);
    expect(checkIns(C.NANNY)).toEqual([expect.objectContaining({ latitude: null, longitude: null })]);
    // The control: the child still at home keeps their position.
    expect(live(C.KID)).toMatchObject({ is_sharing: true, ...POSITION, address: '1 Main St' });
    expect(events(C.KID)[0]).toMatchObject(POSITION);
    expect(checkIns(C.KID)[0]).toMatchObject(POSITION);
  });
});

describe('the family and settings screens removing a member', () => {
  it.each(['components/modules/family-module.tsx', 'components/modules/settings-module.tsx'])('%s removes through the server action, which forgets the member\'s location right after the confirmed removal', (file) => {
    // The browser write moved into removeFamilyMemberAction (a removed child's
    // PIN login and their location both need the service role), so the forget
    // is not a second call a screen could leave out: every removal from either
    // screen is the action, and the action forgets right after the write.
    const src = readFileSync(file, 'utf8');
    expect(src).toContain("import { removeFamilyMemberAction } from '@/app/(app)/family/member-actions';");
    expect(src).toMatch(/await removeFamilyMemberAction\(/);
    expect(src).not.toContain('.update({ is_active: false })');
    const action = readFileSync('app/(app)/family/member-actions.ts', 'utf8');
    expect(action).toContain("import { forgetMemberLocation } from '@/lib/location/retention';");
    expect(at(action, '.update(REMOVED_MEMBER_PATCH)')).toBeLessThan(at(action, 'await forgetMemberLocation('));
  });

  it('the server action the screens call blanks the removed member\'s position and history, and nobody else\'s', async () => {
    household(true);
    const { removeFamilyMemberAction } = await import('@/app/(app)/family/member-actions');
    expect(await removeFamilyMemberAction({ memberId: C.NANNY })).toEqual({ ok: true, loginRevocation: 'none', locationForgotten: true });
    expect(db.table('family_members').find((row) => row.id === C.NANNY)).toMatchObject({ is_active: false });
    expect(live(C.NANNY)).toMatchObject(CLEARED);
    expect(events(C.NANNY)).toEqual([expect.objectContaining({ latitude: null, longitude: null, place_name: 'Home', event_type: 'arrived' })]);
    expect(checkIns(C.NANNY)).toEqual([expect.objectContaining({ latitude: null, longitude: null })]);
    expect(live(C.KID)).toMatchObject({ is_sharing: true, ...POSITION, address: '1 Main St' });
    expect(events(C.KID)[0]).toMatchObject(POSITION);
    expect(checkIns(C.KID)[0]).toMatchObject(POSITION);
  });

  it('the action clears a removed member of the manager\'s own family', async () => {
    household(false);
    const { forgetRemovedMemberLocationAction } = await import('@/app/(app)/family/member-removal-actions');
    expect(await forgetRemovedMemberLocationAction(C.NANNY)).toEqual({ ok: true });
    expect(live(C.NANNY)).toMatchObject(CLEARED);
    expect(events(C.NANNY)[0]).toMatchObject({ latitude: null, longitude: null });
    expect(checkIns(C.NANNY)[0]).toMatchObject({ latitude: null, longitude: null });
    expect(live(C.KID)).toMatchObject({ is_sharing: true, ...POSITION });
  });

  it('is not a way to blank an active member, another family\'s member, or anything as a non-manager', async () => {
    household(true);
    const { forgetRemovedMemberLocationAction } = await import('@/app/(app)/family/member-removal-actions');
    expect(await forgetRemovedMemberLocationAction(C.NANNY), 'still active').toEqual({ ok: false });
    expect(live(C.NANNY)).toMatchObject({ is_sharing: true, ...POSITION });
    expect(await forgetRemovedMemberLocationAction(C.STRANGER), 'another family\'s removed member').toEqual({ ok: false });
    expect(live(C.STRANGER)).toMatchObject({ is_sharing: true, ...POSITION });
    seam.role = 'child';
    db.replace('family_members', db.table('family_members').map((row) => (row.id === C.NANNY ? { ...row, is_active: false } : row)));
    expect(await forgetRemovedMemberLocationAction(C.NANNY), 'a child cannot do it').toEqual({ ok: false });
    expect(live(C.NANNY)).toMatchObject({ is_sharing: true, ...POSITION });
  });
});

describe('location history retention', () => {
  it('drops events older than the window and clears the coordinates nothing reads', async () => {
    const { enforceLocationRetention, LOCATION_EVENT_RETENTION_DAYS } = await import('@/lib/location/retention');
    const now = new Date('2026-06-15T12:00:00Z');
    const old = new Date(now.getTime() - (LOCATION_EVENT_RETENTION_DAYS + 10) * DAY).toISOString();
    const recent = new Date(now.getTime() - DAY).toISOString();
    db.seed('location_events', [
      { id: 'old', family_id: C.FAMILY, member_id: C.KID, ...POSITION, event_type: 'left', place_name: 'School', occurred_at: old },
      { id: 'recent', family_id: C.FAMILY, member_id: C.KID, ...POSITION, event_type: 'arrived', place_name: 'Home', occurred_at: recent },
      { id: 'bare', family_id: C.FAMILY, member_id: C.KID, latitude: null, longitude: null, event_type: 'arrived', place_name: 'Home', occurred_at: recent },
    ]);
    db.seed('safety_check_ins', [
      { id: 'old-checkin', family_id: C.FAMILY, member_id: C.KID, ...POSITION, created_at: old },
      { id: 'recent-checkin', family_id: C.FAMILY, member_id: C.KID, ...POSITION, created_at: recent },
    ]);
    const result = await enforceLocationRetention(db as unknown as SupabaseClient, now);
    expect(result).toMatchObject({ ok: true, purgedEvents: 1, clearedEvents: 1, clearedCheckIns: 1, failures: [] });
    expect(db.table('location_events').map((row) => row.id).sort()).toEqual(['bare', 'recent']);
    expect(db.table('location_events').find((row) => row.id === 'recent')).toMatchObject({ latitude: null, longitude: null, place_name: 'Home' });
    expect(db.table('safety_check_ins').find((row) => row.id === 'old-checkin')).toMatchObject({ latitude: null, longitude: null });
    // A fresh check-in still carries where the member checked in from.
    expect(db.table('safety_check_ins').find((row) => row.id === 'recent-checkin')).toMatchObject(POSITION);
    // Idempotent: the next day's run finds nothing to do.
    expect(await enforceLocationRetention(db as unknown as SupabaseClient, now)).toMatchObject({ ok: true, purgedEvents: 0, clearedEvents: 0, clearedCheckIns: 0 });
  });

  it('is held out of the deployable tree pending the owner\'s retention decision', () => {
    // The sweep deletes location_events and clears coordinates for good. A
    // destructive retention sweep must not be reachable from the deployable
    // candidate until the owner sets a retention policy, so the route file sits
    // under held/, which Next does not route, and neither scheduler carries it.
    // The handler is kept whole there for the day that policy exists;
    // tests/cron-schedule-registration.test.ts holds it by name.
    expect(existsSync('app/api/cron/location-retention/route.ts')).toBe(false);
    const vercel = JSON.parse(readFileSync('vercel.json', 'utf8')) as { crons: { path: string; schedule: string }[] };
    expect(vercel.crons.some((cron) => cron.path === '/api/cron/location-retention')).toBe(false);
    expect(readFileSync('scripts/cron-dispatch.mjs', 'utf8')).not.toMatch(/'\/api\/cron\/location-retention':\s*'[^']+'/);
    expect(readFileSync('held/api/cron/location-retention/route.ts', 'utf8')).toContain('enforceLocationRetention(createServiceClient())');
  });
});

describe('a removal whose location forget failed', () => {
  it('the server action the screens call says the location is still visible, and the screens show it', async () => {
    household(true);
    refuseLocationTable(db);
    const { removeFamilyMemberAction } = await import('@/app/(app)/family/member-actions');
    // The defect: { ok: true, loginRevocation: 'none' } — nothing a screen could
    // read to say the position was not cleared.
    expect(await removeFamilyMemberAction({ memberId: C.NANNY })).toEqual({ ok: true, loginRevocation: 'none', locationForgotten: false });
    expect(db.table('family_members').find((row) => row.id === C.NANNY), 'the removal stands').toMatchObject({ is_active: false });
    expect(live(C.NANNY), 'the row is as the refused write left it').toMatchObject({ is_sharing: true, ...POSITION });
    expect(console.error).toHaveBeenCalled();
    for (const file of ['components/modules/family-module.tsx', 'components/modules/settings-module.tsx']) {
      const src = readFileSync(file, 'utf8');
      expect(src, file).toContain('res.locationForgotten');
      expect(src, file).toContain("t('familyModule.removedButLocationStillVisible')");
    }
  });

  it('the admin console removal returns the same warning', async () => {
    household(true);
    refuseLocationTable(db);
    const { adminRemoveMemberAction } = await import('@/app/(app)/admin/actions');
    expect(await adminRemoveMemberAction(C.NANNY)).toEqual({ ok: true, data: { warning: 'familyModule.removedButLocationStillVisible' } });
    expect(db.table('family_members').find((row) => row.id === C.NANNY)).toMatchObject({ is_active: false });
  });

  it('the warning is in every catalogue the product ships as a translation', () => {
    for (const locale of ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT']) {
      const catalogue = JSON.parse(readFileSync(`lib/i18n/messages/${locale}.json`, 'utf8')) as Record<string, string>;
      expect(catalogue['familyModule.removedButLocationStillVisible'], locale).toBeTruthy();
    }
  });

  it('is repaired by the retention sweep: a live row whose member is no longer active is blanked, and an active member\'s is not', async () => {
    // The removal happened, the forget did not: the nanny is inactive and her
    // live row still says where she is.
    household(false);
    const { enforceLocationRetention } = await import('@/lib/location/retention');
    const result = await enforceLocationRetention(db as unknown as SupabaseClient);
    // The defect: the sweep never read member_locations, so this row was
    // permanent — readable by the remaining family, and plotted on their map.
    expect(result).toMatchObject({ ok: true, clearedRemovedMembers: 2, failures: [] });
    expect(live(C.NANNY)).toMatchObject(CLEARED);
    expect(live(C.KID)).toMatchObject({ is_sharing: true, ...POSITION, address: '1 Main St' });
    // The stranger is another family's removed member: removed is removed.
    expect(live(C.STRANGER)).toMatchObject(CLEARED);
    // Idempotent: the next run finds nothing to do.
    expect(await enforceLocationRetention(db as unknown as SupabaseClient)).toMatchObject({ ok: true, clearedRemovedMembers: 0 });
  });

  it('the sweep also catches a row that stopped sharing but kept its last position', async () => {
    household(false);
    db.replace('member_locations', db.table('member_locations').map((row) => (row.member_id === C.NANNY ? { ...row, is_sharing: false } : row)));
    const { enforceLocationRetention } = await import('@/lib/location/retention');
    expect(await enforceLocationRetention(db as unknown as SupabaseClient)).toMatchObject({ ok: true, clearedRemovedMembers: 2 });
    expect(live(C.NANNY)).toMatchObject(CLEARED);
  });

  it('the sweep reports a refused repair rather than counting it done', async () => {
    household(false);
    refuseLocationTable(db);
    const { enforceLocationRetention } = await import('@/lib/location/retention');
    const result = await enforceLocationRetention(db as unknown as SupabaseClient);
    expect(result.ok).toBe(false);
    expect(result.clearedRemovedMembers).toBe(0);
    expect(result.failures.some((f) => /member_locations/.test(f.step))).toBe(true);
    // Described, never the raw Postgres string.
    for (const f of result.failures) expect(f.message).not.toMatch(/canceling statement/);
  });
});
