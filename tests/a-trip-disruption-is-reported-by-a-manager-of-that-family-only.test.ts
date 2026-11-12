// Call-level role tests for the two vacation-detail server actions
// (Register B group 6), driven through the REAL exported actions, the real
// trips service and the real notify() against the in-memory PostgREST fake.
//
// The policy, from the sources rather than from the action:
//   • vacation_flights / vacation_lodging / vacation_itinerary_* are
//     "Members manage …" FOR ALL is_family_member (0070_vacations.sql:544-547),
//     and lib/auth/guest-scope.ts does not withhold /dashboard/vacations from a
//     guest — so READING the family's bookings is every member's, and only the
//     family's own.
//   • Re-flowing the shared itinerary and paging the family is a manager's act:
//     the action's own comment (actions.ts, "a manager's act"), the service's
//     own gate (lib/services/trips reportTripDisruption → isManager), and
//     isManager = parent | adult (lib/constants/roles.ts). The action writes
//     the family's notifications through notify() with the service role, so
//     RLS is not what stops a teen — the action has to.
//   • Every id argument resolves inside the caller's family only.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

type Ctx = { user: { id: string }; active: { familyId: string; role: string; member: { id: string }; family: { name: string; timezone: string } } };
const holder = vi.hoisted(() => ({ db: null as unknown, ctx: null as Ctx | null }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => holder.db, createServiceClient: () => holder.db }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => {
    // A signed-out caller is sent to /login by redirect(), which throws.
    if (!holder.ctx) throw new Error('NEXT_REDIRECT;/login');
    return holder.ctx;
  },
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

import { listDisruptableBookingsAction, reportDisruptionAction } from '@/app/(app)/dashboard/vacations/[id]/actions';

const FAM_A = '0a000000-0000-4000-8000-00000000000a';
const FAM_B = '0b000000-0000-4000-8000-00000000000b';
const TRIP_A = '0a000000-0000-4000-8000-0000000000a1';
const TRIP_B = '0b000000-0000-4000-8000-0000000000b1';
const FLIGHT_A = '0a000000-0000-4000-8000-0000000000f1';
const FLIGHT_B = '0b000000-0000-4000-8000-0000000000f1';
const STAY_A = '0a000000-0000-4000-8000-0000000000c1';
const STAY_B = '0b000000-0000-4000-8000-0000000000c1';
const DAY = '2026-07-14';

const ROLES = ['parent', 'adult', 'teen', 'child', 'caregiver', 'guest'] as const;
type Role = (typeof ROLES)[number];
const memberId = (fam: 'a' | 'b', role: Role) => `${fam === 'a' ? '0a' : '0b'}000000-0000-4000-8000-${String(ROLES.indexOf(role) + 1).padStart(12, '0')}`;
const userId = (fam: 'a' | 'b', role: Role) => `${fam === 'a' ? '0a' : '0b'}000000-0000-4000-9000-${String(ROLES.indexOf(role) + 1).padStart(12, '0')}`;

const ctxFor = (role: Role): Ctx => ({
  user: { id: userId('a', role) },
  active: { familyId: FAM_A, role, member: { id: memberId('a', role) }, family: { name: 'Family A', timezone: 'UTC' } },
});

const TABLES = ['vacations', 'vacation_flights', 'vacation_lodging', 'vacation_itinerary_days', 'vacation_itinerary_items', 'notifications'];

function seedFamily(db: InMemorySupabase, fam: 'a' | 'b') {
  const family = fam === 'a' ? FAM_A : FAM_B;
  const trip = fam === 'a' ? TRIP_A : TRIP_B;
  const p = fam === 'a' ? '0a' : '0b';
  db.seed('vacations', [{
    id: trip, family_id: family, title: `Trip ${fam}`, destination: 'Barcelona', kind: 'flight', status: 'booked',
    start_date: DAY, end_date: '2026-07-20', timezone: 'UTC', is_international: true,
  }]);
  db.seed('vacation_flights', [{
    id: fam === 'a' ? FLIGHT_A : FLIGHT_B, family_id: family, vacation_id: trip,
    airline: fam === 'a' ? 'BA' : 'IB', flight_number: fam === 'a' ? '274' : '3167',
    depart_airport: 'LHR', arrive_airport: 'BCN', depart_at: `${DAY}T11:00:00Z`, arrive_at: `${DAY}T14:00:00Z`, booked: true,
  }]);
  db.seed('vacation_lodging', [{
    id: fam === 'a' ? STAY_A : STAY_B, family_id: family, vacation_id: trip,
    name: fam === 'a' ? 'Hotel Arts' : 'Casa B', check_in: DAY, check_out: '2026-07-20',
  }]);
  db.seed('vacation_itinerary_days', [{ id: `${p}000000-0000-4000-8000-0000000000d1`, family_id: family, vacation_id: trip, day_date: DAY }]);
  db.seed('vacation_itinerary_items', [
    { id: `${p}000000-0000-4000-8000-0000000000e1`, family_id: family, vacation_id: trip, day_id: `${p}000000-0000-4000-8000-0000000000d1`, kind: 'activity', day_part: 'afternoon', title: 'Sagrada Familia', start_time: '16:00', end_time: '18:00', booked: true },
    { id: `${p}000000-0000-4000-8000-0000000000e2`, family_id: family, vacation_id: trip, day_id: `${p}000000-0000-4000-8000-0000000000d1`, kind: 'meal', day_part: 'evening', title: 'Dinner', start_time: '19:00', end_time: '20:00', booked: true },
  ]);
  db.seed('family_members', ROLES.map((role) => ({
    id: memberId(fam, role), family_id: family, user_id: userId(fam, role), role, is_active: true,
  })));
}

let db: InMemorySupabase;
const snapshot = () => JSON.stringify(TABLES.map((t) => db.table(t)));
const items = (fam: 'a' | 'b') => db.table('vacation_itinerary_items').filter((r) => r.family_id === (fam === 'a' ? FAM_A : FAM_B)) as Row[];
const notes = (fam: 'a' | 'b') => items(fam).filter((r) => r.kind === 'note');
const sagrada = (fam: 'a' | 'b') => items(fam).find((r) => r.title === 'Sagrada Familia');
const familyRows = (fam: string) => JSON.stringify(TABLES.map((t) => db.table(t).filter((r) => r.family_id === fam)));

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase({
    defaults: {
      vacation_itinerary_items: { booked: false, sort_order: 0, member_ids: [], notes: null },
      vacation_itinerary_days: { title: null, summary: null },
      notifications: { is_read: false },
    },
  });
  seedFamily(db, 'a');
  seedFamily(db, 'b');
  holder.db = db;
  holder.ctx = null;
});

const delayed = (vacationId: string, bookingId: string) =>
  ({ vacationId, kind: 'flight' as const, bookingId, outcome: 'delayed' as const, delayMinutes: 120 });

describe('listDisruptableBookingsAction: every member reads their own family’s bookings, and writes nothing', () => {
  it.each(ROLES)('ACTION-03981958F45C a %s of family A gets A’s flight and stay only', async (role) => {
    holder.ctx = ctxFor(role);
    const before = snapshot();
    const result = await listDisruptableBookingsAction(TRIP_A);
    expect(result).toEqual({
      ok: true,
      flights: [{ id: FLIGHT_A, label: 'BA 274', detail: 'LHR → BCN' }],
      lodging: [{ id: STAY_A, label: 'Hotel Arts', detail: `${DAY} – 2026-07-20` }],
    });
    expect(snapshot()).toBe(before);
  });

  it('ACTION-03981958F45C a parent of family A asking for family B’s trip id gets nothing of B’s', async () => {
    holder.ctx = ctxFor('parent');
    const before = snapshot();
    const result = await listDisruptableBookingsAction(TRIP_B);
    expect(result).toEqual({ ok: true, flights: [], lodging: [] });
    expect(snapshot()).toBe(before);
  });

  it('ACTION-03981958F45C a signed-out caller is redirected before any read', async () => {
    const before = snapshot();
    await expect(listDisruptableBookingsAction(TRIP_A)).rejects.toThrow('NEXT_REDIRECT');
    expect(db.log).toEqual([]);
    expect(snapshot()).toBe(before);
  });
});

describe('reportDisruptionAction: a manager of the family re-flows its itinerary and tells its members', () => {
  it.each(['parent', 'adult'] as const)('ACTION-6E60DCF988F2 a %s moves A’s itinerary, files one note and notifies A only', async (role) => {
    holder.ctx = ctxFor(role);
    const bBefore = familyRows(FAM_B);
    const result = await reportDisruptionAction(delayed(TRIP_A, FLIGHT_A));
    expect(result).toMatchObject({ ok: true, noChange: false, recorded: true, notified: true, alreadyApplied: false });
    expect(sagrada('a')).toMatchObject({ start_time: '18:00', end_time: '20:00' });
    expect(items('a').find((r) => r.title === 'Dinner')).toMatchObject({ start_time: '21:00', end_time: '22:00' });
    expect(notes('a')).toHaveLength(1);
    const sent = db.table('notifications');
    expect(sent.length).toBeGreaterThan(0);
    expect(new Set(sent.map((n) => n.family_id))).toEqual(new Set([FAM_A]));
    const aUsers = new Set(ROLES.map((r) => userId('a', r)));
    expect(sent.every((n) => aUsers.has(String(n.user_id)))).toBe(true);
    expect(familyRows(FAM_B)).toBe(bBefore);
  });

  it.each(['teen', 'child', 'caregiver', 'guest'] as const)('ACTION-6E60DCF988F2 a %s is refused and nothing moves or is sent', async (role) => {
    holder.ctx = ctxFor(role);
    const before = snapshot();
    const result = await reportDisruptionAction(delayed(TRIP_A, FLIGHT_A));
    expect(result).toEqual({ ok: false, error: 'vacationDisruption.parentsOnly' });
    expect(sagrada('a')).toMatchObject({ start_time: '16:00', end_time: '18:00' });
    expect(notes('a')).toHaveLength(0);
    expect(db.table('notifications')).toHaveLength(0);
    expect(snapshot()).toBe(before);
  });

  it('ACTION-6E60DCF988F2 a signed-out caller is redirected and nothing is written', async () => {
    const before = snapshot();
    await expect(reportDisruptionAction(delayed(TRIP_A, FLIGHT_A))).rejects.toThrow('NEXT_REDIRECT');
    expect(snapshot()).toBe(before);
  });

  it('ACTION-6E60DCF988F2 a parent of A naming B’s trip and flight is told it is not found; neither family changes', async () => {
    holder.ctx = ctxFor('parent');
    const before = snapshot();
    const result = await reportDisruptionAction(delayed(TRIP_B, FLIGHT_B));
    expect(result).toEqual({ ok: false, error: 'That trip could not be found.' });
    expect(sagrada('b')).toMatchObject({ start_time: '16:00', end_time: '18:00' });
    expect(notes('b')).toHaveLength(0);
    expect(db.table('notifications')).toHaveLength(0);
    expect(snapshot()).toBe(before);
  });

  it('ACTION-6E60DCF988F2 a parent of A naming B’s flight on A’s own trip moves nothing', async () => {
    holder.ctx = ctxFor('parent');
    const before = snapshot();
    const result = await reportDisruptionAction(delayed(TRIP_A, FLIGHT_B));
    expect(result).toEqual({ ok: false, error: 'That flight is not on this trip.' });
    expect(db.table('notifications')).toHaveLength(0);
    expect(snapshot()).toBe(before);
  });
});
