// POST /api/weekend/discover (API-C282DCE0790A), end to end: the real handler,
// the real getUserContext over an in-memory database seeded with two
// households, the real feature gate and rate limiter. The network is a
// fixture: Ticketmaster through a stubbed `fetch`, a family's saved feeds
// through `fetchPublicCalendarText`, the seam the neighbouring tests stub.
//
// Already proven elsewhere and not repeated here:
//   tests/weekend-discovery-reads-feeds-in-bounded-time-and-says-what-failed.test.ts
//     — feed parsing, all-day dates, every-source-failed is 502, the feed cap,
//     concurrency and deadline (all with auth, gate and limiter mocked);
//   tests/a-provider-that-trickles-its-body-does-not-hold-the-weekend-search.test.ts
//     — a provider body read within one deadline;
//   tests/an-ai-answer-is-not-built-on-a-read-that-failed.test.ts — the source
//     reports a failed feed read through `sourceErrors`.
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';
import { rateLimitHit } from './helpers/rate-limit-rpc';
import { EVERY_ROLE, HOUSEHOLD_A, HOUSEHOLD_B, USER_B, seedTwoHouseholds, userA, type HouseholdPlan } from './helpers/two-households-every-role';
import type { MemberRole } from '@/lib/constants/roles';

const h = vi.hoisted(() => ({ db: null as unknown, feedsFetched: [] as string[], feedText: new Map<string, string>() }));
vi.mock('@/lib/i18n/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/i18n/server')>()),
  getTranslations: async () => (key: string) => key,
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db, createServiceClient: () => h.db }));
vi.mock('@/lib/server/public-calendar-fetch', () => ({
  fetchPublicCalendarText: async (url: string) => {
    h.feedsFetched.push(url);
    const text = h.feedText.get(url);
    return text === undefined ? { ok: false, error: 'unreachable', status: 404 } : { ok: true, url, text };
  },
}));

const { POST } = await import('@/app/api/weekend/discover/route');

const FEED_A = '00000000-0000-4000-8000-0000000a0401';
const FEED_B = '00000000-0000-4000-8000-0000000b0401';
const FEED_A_URL = 'https://feeds.example.com/household-a.ics';
const FEED_B_URL = 'https://feeds.example.com/household-b.ics';
const INTERNAL = 'relation "weekend_feeds" internal detail 0xDEAD';
const B_STAMP = '2026-01-01T00:00:00.000Z';

let db: InMemorySupabase;
let fetchCalls: string[];
let clock = Date.parse('2026-10-14T12:00:00.000Z');

const hoursFromNow = (hours: number) => new Date(clock + hours * 3_600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const ics = (uid: string, title: string, hours: number) => [
  'BEGIN:VCALENDAR', 'BEGIN:VEVENT', `UID:${uid}`, `SUMMARY:${title}`,
  `DTSTART:${hoursFromNow(hours).replace(/[-:]/g, '')}`, 'END:VEVENT', 'END:VCALENDAR',
].join('\r\n');

function signIn(userId: string | null, plan: HouseholdPlan = 'basic') {
  db = createInMemorySupabase({
    userId,
    rpc: { rate_limit_hit: rateLimitHit, is_super_admin: () => false },
    uniques: { weekend_events: [['family_id', 'source', 'external_id']] },
  });
  seedTwoHouseholds(db, plan);
  db.seed('weekend_feeds', [
    { id: FEED_A, family_id: HOUSEHOLD_A, label: 'A library', url: FEED_A_URL, kind: 'ics', is_active: true, last_fetched_at: null, last_status: null, last_count: 0 },
    { id: FEED_B, family_id: HOUSEHOLD_B, label: 'B parks', url: FEED_B_URL, kind: 'ics', is_active: true, last_fetched_at: B_STAMP, last_status: 'ok', last_count: 3 },
  ]);
  // Household B already holds the same Ticketmaster event A is about to find.
  db.seed('weekend_events', [{
    id: '00000000-0000-4000-8000-0000000b0501', family_id: HOUSEHOLD_B, source: 'ticketmaster', external_id: 'tm-1',
    title: 'B saved show', starts_at: hoursFromNow(24), search_zip: '10001', created_by: USER_B,
  }]);
  h.db = db;
}

const search = (body: Record<string, unknown> = { zip: '94110', radius: 25, days: 3 }) =>
  POST(new NextRequest('http://localhost/api/weekend/discover', { method: 'POST', body: JSON.stringify(body) }));

const snapshotB = () => JSON.stringify([
  db.table('weekend_feeds').filter((row) => row.family_id === HOUSEHOLD_B),
  db.table('weekend_events').filter((row) => row.family_id === HOUSEHOLD_B),
  db.table('weekend_searches').filter((row) => row.family_id === HOUSEHOLD_B),
]);

function expectNothingReachedOrWritten() {
  expect(fetchCalls).toEqual([]);
  expect(h.feedsFetched).toEqual([]);
  expect(db.table('weekend_events')).toHaveLength(1);
  expect(db.table('weekend_searches')).toEqual([]);
  expect(db.table('weekend_feeds').find((row) => row.id === FEED_A)).toMatchObject({ last_fetched_at: null });
}

beforeEach(() => {
  clock += 5 * 60_000;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(clock);
  fetchCalls = [];
  h.feedsFetched = [];
  h.feedText = new Map([[FEED_A_URL, ics('a-story@example.com', 'A story time', 30)], [FEED_B_URL, ics('b-swim@example.com', 'B swim', 30)]]);
  vi.stubEnv('TICKETMASTER_API_KEY', 'tm-fixture-key');
  vi.stubEnv('SEATGEEK_CLIENT_ID', '');
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    fetchCalls.push(String(url));
    return new Response(JSON.stringify({ _embedded: { events: [{ id: 'tm-1', name: 'Evening show', dates: { start: { dateTime: hoursFromNow(24) } } }] } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('API-C282DCE0790A POST /api/weekend/discover', () => {
  it('API-C282DCE0790A refuses a signed-out caller with 401, before any provider, feed or write', async () => {
    signIn(null);

    const response = await search();

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'discover.unauthorized' });
    expectNothingReachedOrWritten();
    expect(db.table('rate_limits')).toEqual([]);
  });

  it.each(EVERY_ROLE)('API-C282DCE0790A a household-A %s searches with A\'s own feeds and stores the events under household A', async (role: MemberRole) => {
    signIn(userA(role));
    const before = snapshotB();

    const response = await search();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ count: 2, zip: '94110', radius: 25, days: 3, sources: ['ticketmaster', 'feed:A library'], errors: {} });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]).toContain('postalCode=94110');
    expect(h.feedsFetched).toEqual([FEED_A_URL]);
    const mine = db.table('weekend_events').filter((row) => row.family_id === HOUSEHOLD_A);
    expect(mine.map((row) => row.title).sort()).toEqual(['A story time', 'Evening show']);
    for (const row of mine) expect(row).toMatchObject({ search_zip: '94110', search_radius: 25, created_by: userA(role) });
    expect(db.table('weekend_searches')).toHaveLength(1);
    expect(db.table('weekend_searches')[0]).toMatchObject({ family_id: HOUSEHOLD_A, zip: '94110', radius_miles: 25, days: 3, result_count: 2, created_by: userA(role) });
    expect(db.table('weekend_feeds').find((row) => row.id === FEED_A)).toMatchObject({ last_status: 'ok', last_count: 1 });
    expect(snapshotB()).toBe(before);
  });

  it('API-C282DCE0790A household B\'s feeds are never fetched for A, and B\'s copy of the same event is not overwritten', async () => {
    signIn(userA('parent'));
    const before = snapshotB();

    expect((await search()).status).toBe(200);

    expect(h.feedsFetched).not.toContain(FEED_B_URL);
    expect(db.table('weekend_feeds').find((row) => row.id === FEED_B)).toMatchObject({ last_fetched_at: B_STAMP, last_count: 3 });
    const copies = db.table('weekend_events').filter((row) => row.external_id === 'tm-1');
    expect(copies.map((row) => [row.family_id, row.title]).sort()).toEqual([[HOUSEHOLD_A, 'Evening show'], [HOUSEHOLD_B, 'B saved show']]);
    expect(snapshotB()).toBe(before);
  });

  it('API-C282DCE0790A household B\'s parent reads only B\'s feed', async () => {
    signIn(USER_B);

    expect((await search()).status).toBe(200);

    expect(h.feedsFetched).toEqual([FEED_B_URL]);
    expect(db.table('weekend_feeds').find((row) => row.id === FEED_A)).toMatchObject({ last_fetched_at: null });
    expect(db.table('weekend_events').filter((row) => row.family_id === HOUSEHOLD_A)).toEqual([]);
  });

  it('API-C282DCE0790A a Free household A is refused by the Weekend Planner gate (Family Basic) before any provider', async () => {
    signIn(userA('parent'), 'free');

    const response = await search();

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'plan_required', needLevel: 1 });
    expectNothingReachedOrWritten();
    expect(db.table('rate_limits')).toEqual([]);
  });

  it('API-C282DCE0790A the thirteenth search in a minute is refused 429 before any provider', async () => {
    signIn(userA('teen'));
    for (let i = 0; i < 12; i += 1) expect((await search()).status).toBe(200);
    fetchCalls = [];
    h.feedsFetched = [];

    const response = await search();

    expect(response.status).toBe(429);
    expect(fetchCalls).toEqual([]);
    expect(h.feedsFetched).toEqual([]);
    expect(db.table('weekend_searches')).toHaveLength(12);
  });

  it('API-C282DCE0790A a feed list that cannot be read is named in the answer, never folded into a complete one', async () => {
    signIn(userA('parent'));
    h.db = withFaults(db, (table, calls) => (table === 'weekend_feeds' && calls.some((call) => call.method === 'select') ? { message: INTERNAL } : null));

    const response = await search();

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toMatchObject({ count: 1, sources: ['ticketmaster'], errors: { feeds: 'Your saved local feeds could not be loaded.' } });
    expect(text).not.toContain(INTERNAL);
    expect(h.feedsFetched).toEqual([]);
  });

  it('API-C282DCE0790A with the provider off and the feed list unreadable, the search is an outage (502), not an empty weekend', async () => {
    signIn(userA('parent'));
    vi.stubEnv('TICKETMASTER_API_KEY', '');
    h.db = withFaults(db, (table, calls) => (table === 'weekend_feeds' && calls.some((call) => call.method === 'select') ? { message: INTERNAL } : null));

    const response = await search();

    expect(response.status).toBe(502);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: 'discover.eventSourcesUnreachable', errors: { feeds: 'Your saved local feeds could not be loaded.' } });
    expect(text).not.toContain(INTERNAL);
    expect(db.table('weekend_searches')).toEqual([]);
  });

  it('API-C282DCE0790A an event write that fails is a 500 with no internal text and no search recorded', async () => {
    signIn(userA('parent'));
    h.db = withFaults(db, (table, calls) => (table === 'weekend_events' && calls.some((call) => call.method === 'upsert') ? { message: INTERNAL } : null));

    const response = await search();

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: 'discover.couldNotSaveDiscoveredEvents' });
    expect(text).not.toContain(INTERNAL);
    expect(db.table('weekend_searches')).toEqual([]);
  });
});
