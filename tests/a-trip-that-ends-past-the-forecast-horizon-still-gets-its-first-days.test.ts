// Two ways the trip weather route blamed the wrong thing.
//
//   • `fetchForecast` tested only the trip's START against the forecast
//     horizon and sent the trip's END as `end_date` untouched. The provider
//     refuses a range that runs past the last day it forecasts (HTTP 400), so
//     every trip that starts inside the horizon and ends beyond it (a week away
//     starting in nine days) got 502 "weather service is temporarily
//     unavailable" and no forecast for the days that ARE in range.
//   • `geocode` answered null for a provider response that was not OK, and the
//     route reads null as "could not find location": a 404 that tells the
//     family their destination does not exist when the provider was down.
//
// The provider is a stub of `fetch` throughout: it keeps the two hosts apart,
// refuses an out-of-range `end_date` the way the real one does, and counts the
// days in the PLACE's own calendar, which is what `timezone=auto` means. No
// request leaves the process.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const TRIP = { id: 'trip-1', start_date: '2026-11-20', end_date: '2026-11-27' };
const state = vi.hoisted(() => ({
  trip: null as null | { id: string; start_date: string | null; end_date: string | null },
  upserts: [] as { forecast_date: string }[][],
}));

vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => ({
  user: { id: 'user-1' },
  active: { familyId: 'family-1', role: 'parent', member: { id: 'mem-1' }, family: { timezone: 'America/Los_Angeles' } },
}) }));
vi.mock('@/lib/server/route-feature-gate', () => ({ refuseUnlessEntitled: async () => null }));
vi.mock('@/lib/server/request-rate-limit', () => ({ enforceRequestRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => ({
  from: (table: string) => {
    const b: Record<string, unknown> = {};
    Object.assign(b, {
      select: () => b, eq: () => b, or: () => b, delete: () => b,
      upsert: (rows: { forecast_date: string }[]) => { state.upserts.push(rows); return b; },
      maybeSingle: () => Promise.resolve({ data: table === 'vacations' ? state.trip : null, error: null }),
      then: (resolve: (value: unknown) => unknown) => resolve({ data: [], error: null }),
    });
    return b;
  },
}) }));

import { POST } from '@/app/api/vacations/weather/route';
import { FORECAST_HORIZON_DAYS, fetchForecast, geocode } from '@/lib/vacations/weather-fetch';

const DAY_MS = 24 * 60 * 60 * 1000;
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

type Provider = { utcOffsetHours: number; geocodeStatus: number; places: number; forecastUrls: URL[] };
let provider: Provider;

/** The forecast provider: today plus fifteen more days, counted where the place is. */
function stubProvider(input: RequestInfo | URL): Response {
  const url = new URL(String(input));
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (url.hostname === 'geocoding-api.open-meteo.com') {
    if (provider.geocodeStatus !== 200) return json({ error: true, reason: 'upstream unavailable' }, provider.geocodeStatus);
    return json(provider.places ? { results: [{ name: 'Lisbon', latitude: 38.72, longitude: -9.14, country: 'Portugal' }] } : {});
  }
  if (url.hostname !== 'api.open-meteo.com') throw new Error(`unexpected host ${url.hostname}`);
  provider.forecastUrls.push(url);
  const localNow = Date.now() + provider.utcOffsetHours * 60 * 60 * 1000;
  const first = dayOf(localNow);
  const last = dayOf(localNow + FORECAST_HORIZON_DAYS * DAY_MS);
  const start = url.searchParams.get('start_date');
  const end = url.searchParams.get('end_date');
  if (!start || !end) throw new Error('this stub answers dated requests only');
  for (const [name, value] of [['start_date', start], ['end_date', end]]) {
    if (value < first || value > last) {
      return json({ error: true, reason: `Parameter '${name}' is out of allowed range from ${first} to ${last}` }, 400);
    }
  }
  if (end < start) return json({ error: true, reason: 'End-date must be larger or equals than start-date' }, 400);
  const time: string[] = [];
  for (let at = Date.parse(`${start}T00:00:00Z`); dayOf(at) <= end; at += DAY_MS) time.push(dayOf(at));
  return json({ daily: { time, temperature_2m_max: time.map(() => 18), temperature_2m_min: time.map(() => 9) } });
}

const post = () => POST(new NextRequest('http://localhost/api/vacations/weather', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ vacationId: TRIP.id, location: 'Lisbon' }),
}));

beforeEach(() => {
  provider = { utcOffsetHours: 0, geocodeStatus: 200, places: 1, forecastUrls: [] };
  state.trip = { ...TRIP };
  state.upserts = [];
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-11T09:00:00Z'));
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => stubProvider(input)));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('a trip that starts inside the forecast horizon and ends beyond it', () => {
  it('the route answers with the days that are in range, not 502', async () => {
    const res = await post();
    expect(await res.json()).toEqual({ snapshots: 6, location: 'Lisbon' });
    expect(res.status).toBe(200);
    expect(state.upserts).toHaveLength(1);
    expect(state.upserts[0].map((row) => row.forecast_date)).toEqual(
      ['2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23', '2026-11-24', '2026-11-25']);
  });

  // The 25th, though this stub's place (on UTC) is forecast to the 26th: the
  // request does not know where the place's midnight falls, so it stops at the
  // last day that is in range wherever the place is.
  it('asks the provider for the trip start to the last day that is in range anywhere, never the trip end', async () => {
    await fetchForecast(38.72, -9.14, TRIP.start_date, TRIP.end_date);
    expect(provider.forecastUrls).toHaveLength(1);
    expect(provider.forecastUrls[0].searchParams.get('start_date')).toBe('2026-11-20');
    expect(provider.forecastUrls[0].searchParams.get('end_date')).toBe('2026-11-25');
  });

  it('a trip that ends inside the horizon is asked for whole, to its own last day', async () => {
    const days = await fetchForecast(38.72, -9.14, '2026-11-14', '2026-11-18');
    expect(provider.forecastUrls[0].searchParams.get('end_date')).toBe('2026-11-18');
    expect(days.map((d) => d.forecast_date)).toEqual(['2026-11-14', '2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18']);
  });

  // `timezone=auto` counts the provider's days where the PLACE is. A place
  // behind UTC is still on yesterday in the small hours of the UTC day, and a
  // place ahead of it is already on tomorrow late in the UTC day: the last day
  // asked for has to be inside the range in both.
  it.each([
    ['Honolulu, ten hours behind UTC, at 02:00 UTC', -10, '2026-11-11T02:00:00Z'],
    ['Los Angeles, eight hours behind UTC, at 07:59 UTC', -8, '2026-11-11T07:59:00Z'],
    ['Tokyo, nine hours ahead of UTC, at 20:00 UTC', 9, '2026-11-11T20:00:00Z'],
    ['Auckland, thirteen hours ahead of UTC, at 23:30 UTC', 13, '2026-11-11T23:30:00Z'],
  ])('the clamped range is inside the provider\'s for %s', async (_name, utcOffsetHours, now) => {
    vi.setSystemTime(new Date(now));
    provider.utcOffsetHours = utcOffsetHours;
    const days = await fetchForecast(0, 0, TRIP.start_date, TRIP.end_date);
    expect(days[0]?.forecast_date).toBe('2026-11-20');
    expect(days.length).toBeGreaterThanOrEqual(5);
  });

  it('a one-day trip on the last forecast day is asked for as that one day, not an inverted range', async () => {
    await fetchForecast(38.72, -9.14, '2026-11-26', null);
    expect(provider.forecastUrls[0].searchParams.get('start_date')).toBe('2026-11-26');
    expect(provider.forecastUrls[0].searchParams.get('end_date')).toBe('2026-11-26');
  });

  it('a trip that starts beyond the horizon is still not asked for at all', async () => {
    expect(await fetchForecast(38.72, -9.14, '2026-12-20', '2026-12-27')).toEqual([]);
    expect(provider.forecastUrls).toEqual([]);
  });
});

describe('a geocoding provider that does not answer is a provider failure, not a missing place', () => {
  it.each([500, 503, 429])('HTTP %i from the geocoder: geocode throws, and the route answers 502', async (status) => {
    provider.geocodeStatus = status;
    await expect(geocode('Lisbon')).rejects.toThrow(String(status));
    const res = await post();
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'weather.weatherServiceIsTemporarilyUnavailable' });
    expect(state.upserts).toEqual([]);
  });

  it('a place the geocoder answered for and did not find is still "could not find location"', async () => {
    provider.places = 0;
    await expect(geocode('Nowhereville')).resolves.toBeNull();
    const res = await post();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'vacationsWeather.couldNotFindLocation' });
  });
});
