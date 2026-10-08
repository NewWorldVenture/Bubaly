import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { orPredicate } from './helpers/in-memory-supabase';
const h = vi.hoisted(() => ({ enabled: false }));
vi.mock('@/lib/calendar/source-capability', () => ({ get CALENDAR_SOURCE_ARCHIVE_ENABLED() { return h.enabled; } }));
vi.mock('@/lib/services/activity', () => ({ recordActivitySafely: async () => {} }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
import { syncToCalendar } from '@/lib/services/trips';
import { readCompleteCalendarCivilOccurrences, searchCalendarOccurrences, validateCalendarCivilWindow } from '@/lib/services/calendar/search-occurrences';
import { tripTools } from '@/lib/ai/tools/trips';

const FAMILY = '10000000-0000-4000-8000-000000000001', TRIP = '60000000-0000-4000-8000-000000000001';
type Row = Record<string, unknown>;
const id = (index: number) => `40000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const flight = (index = 1): Row => ({ id: id(index), family_id: FAMILY, vacation_id: TRIP, airline: 'AA', flight_number: String(index),
  depart_airport: 'JFK', arrive_airport: 'LAX', depart_at: '2026-03-08T09:00:00Z', arrive_at: '2026-03-08T12:00:00Z', confirmation_code: null });
const reservation = (index = 1): Row => ({ id: id(index), family_id: FAMILY, vacation_id: TRIP, name: `Dinner ${index}`, location: null,
  reserved_at: '2026-03-08T19:00:00Z', confirmation_code: null });
const native = (index = 1, patch: Row = {}): Row => ({ id: id(index), family_id: FAMILY, title: `Other ${index}`, description: null, location: null,
  starts_at: '2026-03-08T10:00:00Z', ends_at: null, all_day: false, recurrence: 'none', recurrence_until: null, category: 'general', assignee_id: null,
  feed_id: null, external_uid: null, onboarding_key: null, idempotency_key: null, created_by: null, source_recurrence: null,
  created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', ...patch });
type Options = { trip?: Row; tz?: string; cap?: number; missingCount?: string; laterError?: string; drift?: string; failInsert?: number; badReceipt?: Row; ignoreFamily?: string };
function setup(seed: Record<string, Row[]> = {}, options: Options = {}) {
  const tables: Record<string, Row[]> = { vacations: [{ id: TRIP, family_id: FAMILY, title: 'Synthetic trip', start_date: '2026-03-08', end_date: '2026-03-08', timezone: 'America/New_York', destination: 'Synthetic', ...options.trip }],
    calendar_events: [], vacation_flights: [], vacation_reservations: [], ...structuredClone(seed) };
  const calls: { url: URL; method: string; body: unknown }[] = []; let insertAttempts = 0;
  const db = createClient<Database>('https://trip-sync.synthetic.invalid', 'synthetic-key', { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: async (input, init) => {
    const url = new URL(String(input)), method = init?.method ?? 'GET', body = init?.body ? JSON.parse(String(init.body)) : null;
    expect(url.origin).toBe('https://trip-sync.synthetic.invalid'); calls.push({ url, method, body }); const table = url.pathname.split('/').at(-1)!;
    if (method === 'POST') {
      expect(table).toBe('calendar_events'); insertAttempts++;
      if (insertAttempts === options.failInsert) return Response.json({ message: 'Synthetic insert failure' }, { status: 503 });
      if (tables.calendar_events.some(row => row.idempotency_key === body.idempotency_key)) return Response.json({ code: '23505', message: 'Synthetic duplicate' }, { status: 409 });
      const row = native(10000 + tables.calendar_events.length, body); tables.calendar_events.push(row);
      return Response.json({ ...row, ...options.badReceipt }, { status: 201 });
    }
    expect(method).toBe('GET'); expect(url.searchParams.get('family_id')).toBe('eq.' + FAMILY);
    let rows = [...(tables[table] ?? [])];
    for (const [field, raw] of url.searchParams) {
      const dot = raw.indexOf('.'), operator = raw.slice(0, dot), value = raw.slice(dot + 1);
      if (field === 'or') rows = rows.filter(orPredicate(raw.slice(1, -1)));
      else if (operator === 'eq' && !(['family_id', 'vacation_id'].includes(field) && options.ignoreFamily === table)) rows = rows.filter(row => String(row[field]) === value);
      else if (operator === 'neq') rows = rows.filter(row => String(row[field]) !== value);
      else if (operator === 'not' && value === 'is.null') rows = rows.filter(row => row[field] != null);
      else if (operator === 'gte') rows = rows.filter(row => String(row[field]) >= value);
      else if (operator === 'lte') rows = rows.filter(row => String(row[field]) <= value);
    }
    rows.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const headers = new Headers(init?.headers);
    if (headers.get('accept')?.includes('vnd.pgrst.object')) return Response.json(rows[0] ?? null);
    const offset = Number(url.searchParams.get('offset') ?? 0), limit = Math.min(Number(url.searchParams.get('limit') ?? 1000), options.cap ?? 1000);
    if (offset && options.laterError === table) return Response.json({ message: 'Synthetic later-page failure' }, { status: 503 });
    const page = rows.slice(offset, offset + limit), count = rows.length + (offset && options.drift === table ? 1 : 0);
    return Response.json(page, { headers: options.missingCount === table ? {} : { 'Content-Range': `${offset}-${Math.max(offset, offset + page.length - 1)}/${count}` } });
  } } });
  const scope: ServiceScope = { db, familyId: FAMILY, userId: null, memberId: null, role: 'system', actorKind: 'system', tz: options.tz ?? 'America/New_York', now: new Date('2026-03-01T12:00:00Z') };
  return { scope, tables, calls, execute: () => syncToCalendar(scope, TRIP), writes: () => calls.filter(call => call.method !== 'GET') };
}
beforeEach(() => { h.enabled = false; });

describe('prospective native trip sync through installed SDK', () => {
  it.each([
    ['2026-03-08', '2026-03-09', '2026-03-08T05:00:00.000Z', '2026-03-09T04:00:00.000Z', 23],
    ['2026-11-01', '2026-11-02', '2026-11-01T04:00:00.000Z', '2026-11-02T05:00:00.000Z', 25],
  ])('round-trips canonical DATE %s with %s exclusive end', async (day, next, start, end, hours) => {
    const f = setup({}, { trip: { start_date: day, end_date: day } }); const synced = await f.execute();
    expect(synced).toMatchObject({ ok: true, data: { created: [{ allDay: true, startDate: day, endDate: next }] } });
    expect(f.tables.calendar_events[0]).toMatchObject({ starts_at: `${day}T00:00:00.000Z`, ends_at: `${next}T00:00:00.000Z` });
    const result = await searchCalendarOccurrences(f.scope, { from: `${day}T00:00:00Z`, to: `${next}T12:00:00Z` });
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.data.events[0]).toMatchObject({ startDate: day, endDate: next, actualStartsAt: start, actualEndsAt: end });
    expect(Date.parse(result.data.events[0].actualEndsAt!) - Date.parse(result.data.events[0].actualStartsAt)).toBe(Number(hours) * 3600000);
  });
  it('preserves timed flight/reservation instants and uses distinct child keys under one outer key', async () => {
    const f = setup({ vacation_flights: [flight()], vacation_reservations: [reservation()] }); f.scope.idempotencyKey = 'outer-step';
    const result = await f.execute(); expect(result).toMatchObject({ ok: true }); if (!result.ok) return;
    expect(result.data.created).toHaveLength(3); expect(new Set(result.data.created.map(row => row.id)).size).toBe(3);
    expect(new Set(f.tables.calendar_events.map(row => row.idempotency_key)).size).toBe(3);
    expect(f.tables.calendar_events.find(row => row.title === 'Flight AA 1 JFK → LAX')).toMatchObject({ starts_at: '2026-03-08T09:00:00.000Z', ends_at: '2026-03-08T12:00:00.000Z', all_day: false });
    expect(f.tables.calendar_events.find(row => row.title === 'Dinner 1')).toMatchObject({ starts_at: '2026-03-08T19:00:00.000Z', ends_at: null });
    const writes = f.writes().length; expect(await f.execute()).toEqual({ ok: true, data: { created: [], skipped: ['Synthetic trip', 'Flight AA 1 JFK → LAX', 'Dinner 1'] } }); expect(f.writes()).toHaveLength(writes);
  });
  it('direct identical retry is stable without an outer executor key', async () => {
    const f = setup(); expect((await f.execute()).ok).toBe(true); const writes = f.writes().length;
    expect(await f.execute()).toMatchObject({ ok: true, data: { created: [], skipped: ['Synthetic trip'] } }); expect(f.writes()).toHaveLength(writes);
  });
  it.each(['UTC', 'America/New_York', 'Asia/Tokyo'])('supports exactly 366 civil days in %s', async tz => {
    const f = setup({}, { tz, trip: { timezone: tz, start_date: '2026-01-01', end_date: '2027-01-01' } });
    expect(await f.execute()).toMatchObject({ ok: true }); expect(f.tables.calendar_events[0]).toMatchObject({ starts_at: '2026-01-01T00:00:00.000Z', ends_at: '2027-01-02T00:00:00.000Z' });
  });
  it('supports a 366-day civil trip spanning 366 elapsed days plus one DST hour without widening assistant search', async () => {
    const f = setup({}, { trip: { start_date: '2026-03-09', end_date: '2027-03-09' } });
    expect(await f.execute()).toMatchObject({ ok: true });
    const window = { from: '2026-03-09T04:00:00.000Z', to: '2027-03-10T04:59:59.999Z' };
    const result = await readCompleteCalendarCivilOccurrences(f.scope, window); expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.data.occurrences[0]).toMatchObject({ startDate: '2026-03-09', endDate: '2027-03-10', actualStartsAt: '2026-03-09T04:00:00.000Z', actualEndsAt: '2027-03-10T05:00:00.000Z' });
    expect(Date.parse(result.data.occurrences[0].actualEndsAt!) - Date.parse(result.data.occurrences[0].actualStartsAt)).toBe(366 * 86400000 + 3600000);
    const before = f.calls.length; expect(await searchCalendarOccurrences(f.scope, window)).toMatchObject({ ok: false, code: 'invalid_input' }); expect(f.calls).toHaveLength(before);
  });
  it.each([
    { from: '2026-01-01T00:00:00Z', to: '2027-01-02T23:59:59.999Z' },
    { from: '2026-01-02T00:00:00Z', to: '2026-01-01T23:59:59.999Z' },
    { from: '2026-01-01T00:00:00', to: '2026-01-01T23:59:59.999Z' },
    { from: '2026-02-30T00:00:00Z', to: '2026-03-01T23:59:59.999Z' },
  ])('internal civil reader rejects unsupported days or clocks before transport %j', async window => {
    const f = setup({}, { tz: 'UTC' }); expect(() => validateCalendarCivilWindow(f.scope, window)).toThrow();
    expect(await readCompleteCalendarCivilOccurrences(f.scope, window)).toMatchObject({ ok: false }); expect(f.calls).toHaveLength(0);
  });
  it('rejects a later changed retry before creating an earlier missing candidate', async () => {
    const f = setup({ vacation_flights: [flight()] }); f.scope.idempotencyKey = 'same-attempt'; expect((await f.execute()).ok).toBe(true);
    f.tables.calendar_events = f.tables.calendar_events.filter(row => row.all_day === false); f.tables.vacation_flights[0].arrive_at = '2026-03-08T13:00:00Z';
    const writes = f.writes().length; expect(await f.execute()).toMatchObject({ ok: false }); expect(f.writes()).toHaveLength(writes); expect(f.tables.calendar_events).toHaveLength(1);
  });
  it('refuses matching unkeyed titles without claiming ownership or writing', async () => {
    const f = setup({ calendar_events: [native(1, { title: 'Synthetic trip', starts_at: '2026-03-08T00:00:00.000Z', ends_at: '2026-03-09T00:00:00.000Z', all_day: true })] });
    expect(await f.execute()).toMatchObject({ ok: false, error: expect.stringContaining('unverified trip ownership') }); expect(f.writes()).toHaveLength(0);
  });
  it('holds historic noncanonical DATEs without normalization', async () => {
    const historic = native(1, { all_day: true, starts_at: '2026-03-08T05:00:00Z', ends_at: '2026-03-09T03:59:59.999Z' });
    const f = setup({ calendar_events: [historic] }); expect(await f.execute()).toMatchObject({ ok: false }); expect(f.writes()).toHaveLength(0); expect(f.tables.calendar_events).toEqual([historic]);
  });
  it.each(['', 'Invalid/Zone'])('refuses supplied trip clock %s before writes', async timezone => { const f = setup({}, { trip: { timezone } }); expect((await f.execute()).ok).toBe(false); expect(f.writes()).toHaveLength(0); });
  it.each(['', 'Invalid/Zone'])('refuses family clock %s before transport', async tz => { const f = setup({}, { tz }); expect((await f.execute()).ok).toBe(false); expect(f.calls).toHaveLength(0); });
  it.each([{ start_date: null }, { start_date: '2026-02-30' }, { end_date: '2026-02-28' }, { end_date: '2028-01-01' }, { title: ' ' }, { family_id: 'wrong' }])('refuses invalid trip %j without writes', async trip => { const f = setup({}, { trip }); expect((await f.execute()).ok).toBe(false); expect(f.writes()).toHaveLength(0); });
  it.each([{ depart_at: '2026-03-08T09:00:00' }, { depart_at: '2026-02-30T09:00:00Z' }, { arrive_at: '2026-03-08T08:00:00Z' }, { vacation_id: 'wrong' }, { airline: 4 }])('qualifies every later flight before writes %j', async patch => {
    const f = setup({ vacation_flights: [flight(), { ...flight(2), ...patch }] }, { ignoreFamily: 'vacation_flights' }); expect((await f.execute()).ok).toBe(false); expect(f.writes()).toHaveLength(0);
  });
  it.each(['vacation_flights', 'vacation_reservations'])('completes cap2 %s before writing any candidates', async table => {
    const make = table === 'vacation_flights' ? flight : reservation;
    const f = setup({ [table]: [make(1), make(2), make(3)] }, { cap: 2 }); expect((await f.execute()).ok).toBe(true); expect(f.tables.calendar_events).toHaveLength(4);
    expect(f.calls.some(call => call.url.pathname.endsWith('/' + table) && call.url.searchParams.get('offset') === '2')).toBe(true);
  });
  it.each(['missingCount', 'laterError', 'drift'] as const)('refuses incomplete candidates %s without writes', async failure => {
    const f = setup({ vacation_flights: [flight(1), flight(2), flight(3)] }, { cap: 2, [failure]: 'vacation_flights' }); expect((await f.execute()).ok).toBe(false); expect(f.writes()).toHaveLength(0);
  });
  it('refuses candidate1001 instead of syncing its prefix', async () => { const f = setup({ vacation_flights: Array.from({ length: 1001 }, (_, i) => flight(i + 1)) }); expect((await f.execute()).ok).toBe(false); expect(f.writes()).toHaveLength(0); });
  it('reads calendar row201 before refusing an unverified coincidence', async () => {
    const rows = Array.from({ length: 201 }, (_, i) => native(i + 1)); rows[200] = native(201, { title: 'Synthetic trip', all_day: true, starts_at: '2026-03-08T00:00:00.000Z', ends_at: '2026-03-09T00:00:00.000Z' });
    const f = setup({ calendar_events: rows }, { cap: 2 }); expect((await f.execute()).ok).toBe(false); expect(f.writes()).toHaveLength(0); expect(f.calls.some(call => call.url.searchParams.get('offset') === '200')).toBe(true);
  });
  it('never returns success after a sequential partial failure and retries only missing candidates', async () => {
    const options: Options = { failInsert: 2 }; const f = setup({ vacation_flights: [flight()] }, options); const result = await f.execute();
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('after 1 confirmed entries') }); expect(f.tables.calendar_events).toHaveLength(1);
    options.failInsert = undefined; const retry = await f.execute(); expect(retry).toMatchObject({ ok: true, data: { skipped: ['Synthetic trip'] } }); expect(f.tables.calendar_events).toHaveLength(2);
  });
  it.each([{ id: 'not-an-event-id' }, { family_id: 'wrong' }, { ends_at: null }, { idempotency_key: 'wrong' },
    { created_at: undefined }, { updated_at: undefined }, { created_at: 'bad-clock' }, { updated_at: '2026-02-30T00:00:00Z' },
    { onboarding_key: undefined }, { source_recurrence: { unsafe: true } }])('rejects an unconfirmed write receipt %j', async badReceipt => {
    const f = setup({}, { badReceipt }); expect((await f.execute()).ok).toBe(false); expect(f.tables.calendar_events).toHaveLength(1);
  });
  it('preserves the source-enabled protective hold before writes or reads', async () => { h.enabled = true; const f = setup(); expect((await f.execute()).ok).toBe(false); expect(f.calls).toHaveLength(0); });
  it.each(['America/Los_Angeles', 'Asia/Tokyo'])('tool/schema/JSON preserve civil label in %s', async tz => {
    const f = setup({}, { tz }); const tool = tripTools.find(row => row.name === 'trips.syncToCalendar')!;
    const result = await tool.execute(f.scope, { vacation_id: TRIP }); expect(result.ok).toBe(true); if (!result.ok) return;
    const output = tool.output.parse(JSON.parse(JSON.stringify(result.data)));
    if (!output || typeof output !== 'object' || !('created' in output) || !Array.isArray(output.created)) throw new Error('The sync tool must return created receipts.');
    expect(output.created[0]).toMatchObject({ all_day: true, startDate: '2026-03-08', endDate: '2026-03-09', when: 'all day 2026-03-08 through 2026-03-08' });
    expect(tool.summarize({}, output)).toContain('Confirmed'); expect(tool.summarize({}, output)).toContain('2026-03-08');
    const retry = await tool.execute(f.scope, { vacation_id: TRIP }); expect(retry.ok).toBe(true); if (retry.ok) expect(tool.summarize({}, tool.output.parse(retry.data))).toContain('saved by this sync attempt');
  });
});
