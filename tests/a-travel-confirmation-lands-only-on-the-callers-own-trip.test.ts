// API-FCD111ED9432 — POST /api/vacations/confirmation-import, driven end to end.
//
// tests/travel-confirmation-import-api.test.ts pins the handler with the
// service, the plan gate and the context all stubbed: body parsing, the
// context-identity checks and the status for each service result. Here
// nothing above the database is stubbed — the real getUserContext, the real
// feature gate, the real confirmation-import service with its own fresh
// authorization reads — and `vacation_import_confirmation` is modelled from
// supabase/migrations/0270, so each case reads the receipt, reservation,
// itinerary day and item rows back after the request.
//
// Isolation note: the in-memory database applies no RLS. The household
// boundary here is the route's familyId/memberId match, the service's fresh
// membership read, and the SECURITY DEFINER RPC's membership and
// `trip.family_id = p_family_id` checks, modelled below.
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({ db: null as unknown, rpcCalls: [] as string[] }));
vi.mock('@/lib/supabase/server', () => ({
  createServer: async () => h.db,
  createServiceClient: () => h.db,
}));

import { POST } from '@/app/api/vacations/confirmation-import/route';

const FAMILY_A = 'a0000000-0000-4000-8000-00000000000a';
const FAMILY_B = 'b0000000-0000-4000-8000-00000000000b';
const ROLES = ['parent', 'adult', 'teen', 'child', 'caregiver', 'guest'] as const;
type Role = typeof ROLES[number];
const userOf = (role: Role) => `a1000000-0000-4000-8000-00000000000${ROLES.indexOf(role) + 1}`;
const memberOf = (role: Role) => `a2000000-0000-4000-8000-00000000000${ROLES.indexOf(role) + 1}`;
const USER_B = 'b1000000-0000-4000-8000-000000000001';
const MEMBER_B = 'b2000000-0000-4000-8000-000000000001';
const TRIP_A = 'a3000000-0000-4000-8000-000000000001';
const TRIP_B = 'b3000000-0000-4000-8000-000000000001';
const REQUEST = 'a5000000-0000-4000-8000-000000000001';
const UPDATED = '2026-09-06T12:00:00.123456+00:00';
const URL = 'http://localhost/api/vacations/confirmation-import';
const INTERNAL = 'relation "vacations" internal detail 0xDEADBEEF';
const WRITE_TABLES = ['vacation_confirmation_imports', 'vacation_reservations', 'vacation_itinerary_days', 'vacation_itinerary_items', 'vacations'];

const SOURCE = { title: 'Dinner confirmation', text: 'Name: Dinner\nCode: ABC123\n' };
const FIELDS = { name: 'Dinner', kind: 'dining', location: 'Harbor', reservedAt: '2026-09-10T18:30:45Z', partySize: 4, confirmationCode: 'ABC123', booked: true };

let currentUser: string | null = null;
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

/** supabase/migrations/0270 `vacation_import_confirmation`, over the in-memory tables. */
function importConfirmation(args: Record<string, unknown>, db: InMemorySupabase): unknown {
  h.rpcCalls.push(String(args.p_vacation_id));
  const fail = (code: string): never => { throw Object.assign(new Error(code), { pgCode: code }); };
  const userId = currentUser ?? fail('42501');
  const member = db.table('family_members').find((m) => m.id === args.p_member_id && m.family_id === args.p_family_id
    && m.user_id === userId && m.is_active === true && ['parent', 'adult'].includes(String(m.role)));
  if (!member) fail('42501');
  if ((args.p_expected === null) !== (args.p_request_id === null)) fail('22023');
  const source = args.p_source as { title: string; text: string };
  const fields = args.p_fields as typeof FIELDS;
  const sha256 = createHash('sha256').update(source.text, 'utf8').digest('hex');
  const vSource = { title: source.title.trim(), text: source.text, sha256 };
  const receipt = () => {
    if (args.p_request_id === null) return null;
    const saved = db.table('vacation_confirmation_imports').find((r) => r.id === args.p_request_id);
    if (!saved) return null;
    if (saved.family_id !== args.p_family_id || saved.vacation_id !== args.p_vacation_id || saved.actor_user_id !== userId
      || saved.actor_member_id !== args.p_member_id || !isDeepStrictEqual(json(saved.reviewed), json(args.p_expected))) fail('23505');
    return saved.receipt;
  };
  const early = receipt();
  if (early) return early;
  const trip = db.table('vacations').find((t) => t.id === args.p_vacation_id && t.family_id === args.p_family_id) ?? fail('P0002');
  const tripSnapshot = { id: trip.id, title: trip.title, startDate: trip.start_date, endDate: trip.end_date, timezone: trip.timezone, status: trip.status, updatedAt: trip.updated_at };
  const expected = args.p_expected as Row | null;
  if (expected && !isDeepStrictEqual(json(expected.trip), json(tripSnapshot))) fail('40001');
  if (!['planning', 'booked', 'active', 'completed'].includes(String(trip.status))) fail('55000');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: String(trip.timezone), year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(fields.reservedAt)).map((p) => [p.type, p.value]));
  const localDate = `${parts.year}-${parts.month}-${parts.day}`;
  if (localDate < String(trip.start_date) || localDate > String(trip.end_date)) fail('22023');
  const hour = Number(parts.hour);
  const dayPart = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
  const preview = { version: 1, familyId: args.p_family_id, vacationId: args.p_vacation_id, memberId: args.p_member_id, trip: tripSnapshot,
    source: vSource, fields, itinerary: { date: localDate, startTime: `${parts.hour}:${parts.minute}:${parts.second}`, dayPart } };
  if (!expected) return { preview, applied: false, requestId: null, appliedAt: null, reservationId: null, itineraryItemId: null };
  if (!isDeepStrictEqual(json(expected), json(preview))) fail('40001');
  if (db.table('vacation_confirmation_imports').some((r) => r.vacation_id === args.p_vacation_id && r.source_sha256 === sha256)) fail('23505');
  const reservationId = 'a8000000-0000-4000-8000-000000000001';
  const itemId = 'a9000000-0000-4000-8000-000000000001';
  const appliedAt = '2026-09-06T12:05:00.000000Z';
  const result = { preview, applied: true, requestId: args.p_request_id, appliedAt, reservationId, itineraryItemId: itemId };
  db.table('vacation_confirmation_imports').push({ id: args.p_request_id, family_id: args.p_family_id, vacation_id: args.p_vacation_id,
    actor_user_id: userId, actor_member_id: args.p_member_id, source_title: vSource.title, source_text: vSource.text, source_sha256: sha256,
    reviewed: preview, receipt: result, reservation_id: reservationId, itinerary_item_id: itemId, created_at: appliedAt });
  let day = db.table('vacation_itinerary_days').find((d) => d.vacation_id === args.p_vacation_id && d.day_date === localDate);
  if (!day) {
    day = { id: 'aa000000-0000-4000-8000-000000000001', family_id: args.p_family_id, vacation_id: args.p_vacation_id, day_date: localDate, created_by: userId };
    db.table('vacation_itinerary_days').push(day);
  }
  if (day.family_id !== args.p_family_id) fail('55000');
  db.table('vacation_reservations').push({ id: reservationId, family_id: args.p_family_id, vacation_id: args.p_vacation_id, kind: fields.kind, name: fields.name,
    location: fields.location, reserved_at: fields.reservedAt, party_size: fields.partySize, confirmation_code: fields.confirmationCode, booked: fields.booked, created_by: userId });
  db.table('vacation_itinerary_items').push({ id: itemId, family_id: args.p_family_id, vacation_id: args.p_vacation_id, day_id: day.id, kind: 'reservation',
    day_part: dayPart, title: fields.name, location: fields.location, start_time: preview.itinerary.startTime, booked: fields.booked,
    confirmation_code: fields.confirmationCode, created_by: userId });
  return result;
}

function build(userId: string | null, opts: { plan?: string | null; superAdmin?: boolean } = {}) {
  currentUser = userId;
  const db = createInMemorySupabase({ userId });
  const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
    is_super_admin: () => opts.superAdmin === true,
    vacation_import_confirmation: (args) => importConfirmation(args, db),
  };
  (db as unknown as { rpc: unknown }).rpc = async (name: string, args: Record<string, unknown> = {}) => {
    try {
      return { data: handlers[name](args), error: null };
    } catch (error) {
      return { data: null, error: { code: (error as { pgCode?: string }).pgCode ?? 'XX000', message: INTERNAL, details: null, hint: null } };
    }
  };
  db.seed('families', [
    { id: FAMILY_A, name: 'Household A', timezone: 'UTC', trial_ends_at: null, closed_at: null },
    { id: FAMILY_B, name: 'Household B', timezone: 'UTC', trial_ends_at: null, closed_at: null },
  ]);
  db.seed('family_members', [
    ...ROLES.map((role) => ({ id: memberOf(role), family_id: FAMILY_A, user_id: userOf(role), role, is_active: true })),
    { id: MEMBER_B, family_id: FAMILY_B, user_id: USER_B, role: 'parent', is_active: true },
  ]);
  db.seed('user_preferences', [
    ...ROLES.map((role) => ({ user_id: userOf(role), active_family_id: FAMILY_A })),
    { user_id: USER_B, active_family_id: FAMILY_B },
  ]);
  if (opts.plan !== null) db.seed('subscriptions', [{ family_id: FAMILY_A, plan: opts.plan ?? 'basic', status: 'active', current_period_end: null }]);
  db.seed('subscriptions', [{ family_id: FAMILY_B, plan: 'basic', status: 'active', current_period_end: null }]);
  db.seed('app_settings', [{ key: 'feature_tiers', value: {} }]);
  db.seed('vacations', [
    { id: TRIP_A, family_id: FAMILY_A, title: 'Trip A', start_date: '2026-09-09', end_date: '2026-09-12', timezone: 'UTC', status: 'planning', updated_at: UPDATED },
    { id: TRIP_B, family_id: FAMILY_B, title: 'Trip B', start_date: '2026-09-09', end_date: '2026-09-12', timezone: 'UTC', status: 'planning', updated_at: UPDATED },
  ]);
  h.db = db;
  return db;
}

const body = (role: Role, extra: Record<string, unknown> = {}) => ({ action: 'preview', familyId: FAMILY_A, memberId: memberOf(role), vacationId: TRIP_A, source: SOURCE, fields: FIELDS, ...extra });
const post = (payload: unknown) => POST(new Request(URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }));
const writes = (db: InMemorySupabase) => JSON.stringify(WRITE_TABLES.map((t) => db.table(t)));
const bRows = (db: InMemorySupabase) => JSON.stringify(WRITE_TABLES.map((t) => db.table(t).filter((r) => r.family_id === FAMILY_B)));

beforeEach(() => { h.rpcCalls = []; });

describe('POST /api/vacations/confirmation-import over a two-household database', () => {
  it('API-FCD111ED9432 signed-out: 401, the import RPC is never called and nothing is written', async () => {
    const db = build(null);
    const before = writes(db);
    const response = await post(body('parent'));
    expect(response.status).toBe(401);
    expect(h.rpcCalls).toEqual([]);
    expect(writes(db)).toBe(before);
  });

  it.each(['teen', 'child', 'caregiver', 'guest'] as const)('API-FCD111ED9432 a %s of household A is refused 403 and nothing is written', async (role) => {
    const db = build(userOf(role));
    const before = writes(db);
    const response = await post(body(role));
    expect(response.status).toBe(403);
    expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
    // The route's own refusal, ahead of the service's second role check.
    expect((await response.json()).error).toBe('The active parent or adult family context has changed.');
    expect(h.rpcCalls).toEqual([]);
    expect(writes(db)).toBe(before);
  });

  it.each(['parent', 'adult'] as const)("API-FCD111ED9432 a %s previews the import against A's trip and the preview writes nothing", async (role) => {
    const db = build(userOf(role));
    const before = writes(db);
    const response = await post(body(role));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ applied: false, requestId: null, reservationId: null, itineraryItemId: null });
    expect(result.preview).toMatchObject({ familyId: FAMILY_A, vacationId: TRIP_A, memberId: memberOf(role),
      itinerary: { date: '2026-09-10', startTime: '18:30:45', dayPart: 'evening' } });
    expect(result.preview.trip.title).toBe('Trip A');
    expect(writes(db)).toBe(before);
  });

  it('API-FCD111ED9432 a parent applies the reviewed preview: one receipt, one reservation, one itinerary day and item, all in household A', async () => {
    const db = build(userOf('parent'));
    const reviewed = (await (await post(body('parent'))).json()).preview;
    const response = await post(body('parent', { action: 'apply', expected: reviewed, requestId: REQUEST }));
    expect(response.status).toBe(200);
    const receipt = await response.json();
    expect(receipt).toMatchObject({ applied: true, requestId: REQUEST });
    expect(db.table('vacation_confirmation_imports').map((r) => [r.id, r.family_id, r.vacation_id, r.actor_user_id, r.actor_member_id]))
      .toEqual([[REQUEST, FAMILY_A, TRIP_A, userOf('parent'), memberOf('parent')]]);
    expect(db.table('vacation_reservations').map((r) => [r.id, r.family_id, r.vacation_id, r.name, r.confirmation_code]))
      .toEqual([[receipt.reservationId, FAMILY_A, TRIP_A, 'Dinner', 'ABC123']]);
    expect(db.table('vacation_itinerary_days').map((r) => [r.family_id, r.vacation_id, r.day_date])).toEqual([[FAMILY_A, TRIP_A, '2026-09-10']]);
    expect(db.table('vacation_itinerary_items').map((r) => [r.id, r.family_id, r.day_part, r.start_time]))
      .toEqual([[receipt.itineraryItemId, FAMILY_A, 'evening', '18:30:45']]);
  });

  it('API-FCD111ED9432 a replayed apply returns the original receipt and writes no second reservation', async () => {
    const db = build(userOf('parent'));
    const reviewed = (await (await post(body('parent'))).json()).preview;
    const first = await (await post(body('parent', { action: 'apply', expected: reviewed, requestId: REQUEST }))).json();
    const afterFirst = writes(db);
    const again = await post(body('parent', { action: 'apply', expected: reviewed, requestId: REQUEST }));
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(first);
    expect(writes(db)).toBe(afterFirst);
  });

  it("API-FCD111ED9432 household B's trip id under household A is 404, and nothing of B is changed or returned", async () => {
    const db = build(userOf('parent'));
    const before = bRows(db);
    const response = await post(body('parent', { vacationId: TRIP_B }));
    expect(response.status).toBe(404);
    const text = await response.text();
    expect(JSON.parse(text).code).toBe('not_found');
    expect(text).not.toContain('Trip B');
    expect(bRows(db)).toBe(before);
  });

  it("API-FCD111ED9432 household B's family and member ids are refused 403 before the import, and B is unchanged", async () => {
    const db = build(userOf('parent'));
    const before = bRows(db);
    const response = await post({ ...body('parent'), familyId: FAMILY_B, memberId: MEMBER_B, vacationId: TRIP_B });
    expect(response.status).toBe(403);
    expect(h.rpcCalls).toEqual([]);
    expect(bRows(db)).toBe(before);
  });

  it('API-FCD111ED9432 a family below the trip tier is refused 403 before the import', async () => {
    const db = build(userOf('parent'), { plan: null });
    const before = writes(db);
    const response = await post(body('parent'));
    expect(response.status).toBe(403);
    // The route's feature gate (refuseUnlessEntitled), ahead of the service's own plan check.
    expect(await response.json()).toMatchObject({ code: 'plan_required', needLevel: 1 });
    expect(h.rpcCalls).toEqual([]);
    expect(writes(db)).toBe(before);
  });

  it('API-FCD111ED9432 a failed authorization read is 503 with nothing written and no internal text', async () => {
    const db = build(userOf('parent'));
    const before = writes(db);
    h.db = withFaults(db, (table) => (table === 'user_preferences' ? { message: INTERNAL } : null));
    const response = await post(body('parent'));
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).not.toContain(INTERNAL);
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(['code', 'error']);
    expect(h.rpcCalls).toEqual([]);
    expect(writes(db)).toBe(before);
  });

  it('API-FCD111ED9432 a failed plan read is 503, not a plan refusal, and no import runs', async () => {
    const db = build(userOf('parent'));
    h.db = withFaults(db, (table) => (table === 'subscriptions' ? { message: INTERNAL } : null));
    const response = await post(body('parent'));
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text).code).toBe('unavailable');
    expect(text).not.toContain(INTERNAL);
    expect(h.rpcCalls).toEqual([]);
  });
});
