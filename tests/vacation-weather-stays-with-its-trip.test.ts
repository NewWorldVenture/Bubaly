// Trip weather, three ways it could belong to the wrong thing:
//
//   • the weather route verified the trip through RLS only, then stamped the
//     caller's ACTIVE family id onto the snapshot rows — so a member of two
//     families could re-home family B's trip weather under family A;
//   • a trip beyond Open-Meteo's horizon got the default week-from-today
//     forecast cached under it, and the packing list, readiness card and
//     recommendations read this week's weather as the trip's;
//   • snapshots outside the trip dates were never removed once the trip came
//     into range.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { at } from './helpers/source-order';

const mocks = vi.hoisted(() => ({
  geocode: vi.fn(),
  fetchForecast: vi.fn(),
  fetchWithDeadline: vi.fn(),
  familyId: 'family-A',
  tripFamily: 'family-B',
  calls: [] as { table: string; kind: string; filters: Record<string, unknown>; payload?: unknown; selected?: boolean }[],
}));

vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => ({
  user: { id: 'user-1' },
  active: { familyId: mocks.familyId, role: 'parent', member: { id: 'mem-1' }, family: { timezone: 'America/Los_Angeles' } },
}) }));
vi.mock('@/lib/server/route-feature-gate', () => ({ refuseUnlessEntitled: async () => null }));
vi.mock('@/lib/server/request-rate-limit', () => ({ enforceRequestRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/vacations/weather-fetch', () => ({ geocode: mocks.geocode, fetchForecast: mocks.fetchForecast }));
vi.mock('@/lib/server/fetch-with-deadline', () => ({ fetchWithDeadline: mocks.fetchWithDeadline }));

const TRIP = { id: 'trip-B', family_id: 'family-B', start_date: '2026-11-01', end_date: '2026-11-05' };

/** The caller is a member of BOTH families, so RLS alone lets the read through; only an explicit filter separates them. */
function fakeDb() {
  const from = (table: string) => {
    const call = { table, kind: 'select', filters: {} as Record<string, unknown>, payload: undefined as unknown, selected: false };
    mocks.calls.push(call);
    const b: Record<string, unknown> = {};
    const reply = () => {
      if (table === 'vacations') {
        const visible = !('family_id' in call.filters) || call.filters.family_id === TRIP.family_id;
        return { data: visible && call.filters.id === TRIP.id ? TRIP : null, error: null };
      }
      return { data: [], error: null };
    };
    Object.assign(b, {
      select: () => { call.selected = true; return b; },
      eq: (c: string, v: unknown) => { call.filters[c] = v; return b; },
      or: (expr: string) => { call.filters.or = expr; return b; },
      upsert: (rows: unknown) => { call.kind = 'upsert'; call.payload = rows; return b; },
      delete: () => { call.kind = 'delete'; return b; },
      maybeSingle: () => Promise.resolve(reply()),
      then: (resolve: (value: unknown) => unknown) => resolve(reply()),
    });
    return b;
  };
  return { from };
}
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => fakeDb() }));

import { POST } from '@/app/api/vacations/weather/route';
import { forecastDaysWithin } from '@/lib/vacations/weather';

const { fetchForecast: realFetchForecast } = await vi.importActual<typeof import('@/lib/vacations/weather-fetch')>('@/lib/vacations/weather-fetch');

const post = () => POST(new NextRequest('http://localhost/api/vacations/weather', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ vacationId: TRIP.id, location: 'Tokyo' }),
}));
const day = (forecast_date: string) => ({ forecast_date, temp_high_c: 20, temp_low_c: 10, precip_prob: 10, precip_mm: 0, wind_kph: 5, weather_code: 1 });

beforeEach(() => {
  mocks.calls = [];
  mocks.familyId = 'family-A';
  mocks.geocode.mockReset().mockResolvedValue({ name: 'Tokyo', latitude: 35.7, longitude: 139.7 });
  mocks.fetchForecast.mockReset().mockResolvedValue([day('2026-11-01'), day('2026-11-02')]);
  mocks.fetchWithDeadline.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('the weather route writes only into the trip\'s own family', () => {
  it('a trip from another family the caller belongs to is not found, and nothing is written', async () => {
    const res = await post();
    expect(res.status).toBe(404);
    expect(mocks.calls.find((c) => c.table === 'vacations')?.filters).toMatchObject({ id: TRIP.id, family_id: 'family-A' });
    expect(mocks.calls.filter((c) => c.kind === 'upsert')).toEqual([]);
    expect(mocks.fetchForecast).not.toHaveBeenCalled();
  });

  it('the active family\'s own trip is written with that family\'s id on every row', async () => {
    mocks.familyId = 'family-B';
    const res = await post();
    expect(res.status).toBe(200);
    const upsert = mocks.calls.find((c) => c.kind === 'upsert');
    expect(upsert?.table).toBe('vacation_weather_snapshots');
    for (const row of upsert!.payload as { family_id: string; vacation_id: string }[]) {
      expect(row).toMatchObject({ family_id: 'family-B', vacation_id: TRIP.id });
    }
  });

  it('a refresh clears this location\'s snapshots that fall outside the trip', async () => {
    mocks.familyId = 'family-B';
    expect((await post()).status).toBe(200);
    const stale = mocks.calls.find((c) => c.kind === 'delete');
    expect(stale).toBeDefined();
    expect(stale!.table).toBe('vacation_weather_snapshots');
    expect(stale!.filters).toMatchObject({ family_id: 'family-B', vacation_id: TRIP.id, location_label: 'Tokyo', or: 'forecast_date.lt.2026-11-01,forecast_date.gt.2026-11-05' });
    expect(stale!.selected, 'the delete asks for its rows').toBe(true);
    // The cleanup follows the forecast that was asked for. Both ends are
    // asserted present first: a bare index answers -1 for a missing write and
    // would pass this with the upsert deleted.
    const upsert = mocks.calls.find((c) => c.kind === 'upsert');
    expect(upsert).toBeDefined();
    expect(at(mocks.calls, upsert!)).toBeLessThan(at(mocks.calls, stale!));
  });

  it('a trip beyond the forecast horizon is answered with the note and nothing is written', async () => {
    mocks.familyId = 'family-B';
    mocks.fetchForecast.mockResolvedValue([]);
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ snapshots: [], note: expect.stringContaining('No forecast available') });
    expect(mocks.calls.filter((c) => c.kind === 'upsert' || c.kind === 'delete')).toEqual([]);
  });
});

describe('fetchForecast does not substitute this week for a trip a month away', () => {
  const now = new Date('2026-10-01T12:00:00Z');

  it('returns no days, and makes no request, when the trip starts beyond the horizon', async () => {
    const days = await realFetchForecast(35.7, 139.7, '2026-11-01', '2026-11-05', now);
    expect(days).toEqual([]);
    expect(mocks.fetchWithDeadline).not.toHaveBeenCalled();
  });

  it('asks for exactly the trip dates when they are within the horizon', async () => {
    mocks.fetchWithDeadline.mockResolvedValue(new Response(JSON.stringify({ daily: { time: ['2026-10-10'], temperature_2m_max: [21] } }), { headers: { 'content-type': 'application/json' } }));
    const days = await realFetchForecast(35.7, 139.7, '2026-10-10', '2026-10-12', now);
    expect(days.map((d) => d.forecast_date)).toEqual(['2026-10-10']);
    const url = new URL(String(mocks.fetchWithDeadline.mock.calls[0][0]));
    expect(url.searchParams.get('start_date')).toBe('2026-10-10');
    expect(url.searchParams.get('end_date')).toBe('2026-10-12');
  });
});

describe('forecastDaysWithin', () => {
  const days = [day('2026-10-28'), day('2026-11-01'), day('2026-11-03'), day('2026-11-05'), day('2026-11-06')];
  it('keeps only the days inside the trip, inclusive', () => {
    expect(forecastDaysWithin(days, '2026-11-01', '2026-11-05').map((d) => d.forecast_date)).toEqual(['2026-11-01', '2026-11-03', '2026-11-05']);
  });
  it('treats a one-day trip as its start date and an undated trip as everything', () => {
    expect(forecastDaysWithin(days, '2026-11-03', null).map((d) => d.forecast_date)).toEqual(['2026-11-03']);
    expect(forecastDaysWithin(days, null, null)).toEqual(days);
  });
});
