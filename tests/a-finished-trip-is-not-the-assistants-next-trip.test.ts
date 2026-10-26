// A trip that is over is not the trip the assistant prepares.
//
// Nothing in the app ever moves `vacations.status` past 'planning': there is
// no status editor, no RPC and no cron that completes a trip. So the
// assistant's "trips that are not over" (`listTrips`, filtered on
// planning/booked/active only) was every trip the family ever made, oldest
// first and capped at ten:
//   - last July's trip reached the planner as "(under way)";
//   - ten old trips pushed the real next one out of the context entirely;
//   - the prepare-vacation template picks the soonest `daysUntil`, which for
//     a list full of finished trips is the OLDEST one, so "get us ready for
//     our vacation" built a plan, packing lists, calendar entries and pet
//     tasks on a trip that ended months ago;
//   - "prepare our Florida trip" with no dates (`findOrCreateVacation`)
//     resolved to last year's Florida trip instead of putting this one on file.
//
// A trip whose last day (its end date, else its start date) is before the
// family's today is over, whatever its status. Undated trips are still being
// planned and stay.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import type { SliceEnv } from '@/lib/ai/context/policy';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => { throw new Error('unused'); }, createServer: async () => { throw new Error('unused'); } }));

const FAMILY = '00000000-0000-4000-8000-00000000f101';
const USER = '00000000-0000-4000-8000-0000000000a1';
const PARENT = '00000000-0000-4000-8000-00000000b101';
// Sunday 25 October 2026, 11:00 in New York.
const NOW = new Date('2026-10-25T15:00:00Z');
const TODAY = '2026-10-25';
const TZ = 'America/New_York';

let db: InMemorySupabase;

const trip = (id: string, title: string, start: string | null, end: string | null, extra: Row = {}): Row => ({
  id, family_id: FAMILY, title, destination: null, kind: 'domestic', status: 'planning',
  start_date: start, end_date: end, is_international: false, timezone: TZ, created_by: USER, ...extra,
});

const scope = (): ServiceScope => ({
  db: db as unknown as SupabaseClient<Database>, familyId: FAMILY, userId: USER, memberId: PARENT,
  role: 'parent', actorKind: 'member', tz: TZ, now: NOW,
});

beforeEach(() => {
  db = createInMemorySupabase({ userId: USER });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('listTrips: the trips that are not over', () => {
  it('leaves out a trip that ended, even though nothing marked it completed', async () => {
    db.seed('vacations', [
      trip('lake', 'Lake week', '2026-07-04', '2026-07-11'),
      trip('fall', 'Fall break', '2026-10-23', '2026-10-27'),
      trip('home', 'Coming home today', '2026-10-20', TODAY),
      trip('disney', 'Disney', '2026-12-19', '2026-12-26'),
      trip('today', 'Day at the zoo', TODAY, null),
      trip('fair', 'County fair', '2026-09-01', null),
      trip('someday', 'Someday Japan', null, null),
    ]);
    const { listTrips } = await import('@/lib/services/trips');
    const live = await listTrips(scope());
    expect(live.ok && live.data.map((t) => t.id).sort()).toEqual(['disney', 'fall', 'home', 'someday', 'today']);
  });

  it('still lists every trip when asked for finished ones (the data export)', async () => {
    db.seed('vacations', [trip('lake', 'Lake week', '2026-07-04', '2026-07-11'), trip('disney', 'Disney', '2026-12-19', '2026-12-26')]);
    const { listTrips } = await import('@/lib/services/trips');
    const all = await listTrips(scope(), { includeFinished: true });
    expect(all.ok && all.data.map((t) => t.id).sort()).toEqual(['disney', 'lake']);
  });

  it('finished trips do not push the next one past the limit', async () => {
    db.seed('vacations', [
      ...Array.from({ length: 12 }, (_, i) => trip(`old-${i}`, `Old trip ${i}`, `2025-0${(i % 9) + 1}-01`, `2025-0${(i % 9) + 1}-05`)),
      trip('disney', 'Disney', '2026-12-19', '2026-12-26'),
    ]);
    const { listTrips } = await import('@/lib/services/trips');
    const live = await listTrips(scope(), { limit: 10 });
    expect(live.ok && live.data.map((t) => t.id)).toEqual(['disney']);
  });
});

describe('the travel context and the prepare-vacation template', () => {
  const env = (): SliceEnv => ({
    now: NOW, tz: TZ, todayKey: TODAY, weekFromIso: NOW.toISOString(), weekToIso: NOW.toISOString(),
    viewer: { role: 'parent', memberId: PARENT } as unknown as SliceEnv['viewer'], members: [], pageContext: null,
  });

  it('does not call a trip that ended in July "under way"', async () => {
    db.seed('vacations', [trip('lake', 'Lake week', '2026-07-04', '2026-07-11'), trip('disney', 'Disney', '2026-12-19', '2026-12-26')]);
    const { travelSlice } = await import('@/lib/ai/context/slices/travel');
    const res = await travelSlice.load(scope(), env());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const text = res.data.lines.join('\n');
    expect(text).not.toContain('Lake week');
    expect(text).not.toContain('under way');
    expect(text).toContain('Disney');
  });

  it('"get us ready for our vacation" prepares the coming trip, not the oldest finished one', async () => {
    db.seed('vacations', [
      trip('spring', 'Spring break', '2026-03-28', '2026-04-04'),
      trip('lake', 'Lake week', '2026-07-04', '2026-07-11'),
      trip('disney', 'Disney', '2026-12-19', '2026-12-26'),
    ]);
    const { travelSlice } = await import('@/lib/ai/context/slices/travel');
    const { templateContextFrom, instantiateTemplate, templateFor } = await import('@/lib/ai/planner/templates/index');
    const res = await travelSlice.load(scope(), env());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const trips = (res.data.data as { trips: { id: string; title: string; startDate: string | null; daysUntil: number | null }[] }).trips;
    const ctx = templateContextFrom({
      tz: TZ, nowIso: NOW.toISOString(), todayKey: TODAY, requestText: 'Get us ready for our vacation',
      trips: trips.map((t) => ({ id: t.id, title: t.title, startDate: t.startDate, daysUntil: t.daysUntil })),
    });
    const plan = instantiateTemplate(templateFor('prepare_vacation')!, ctx);
    const tripStep = plan.steps.find((s) => s.key === 'trip')!;
    expect(JSON.parse(tripStep.input)).toMatchObject({ vacation_id: 'disney' });
  });
});

describe('findOrCreateVacation: a trip that is over is not the one a request names', () => {
  it('puts this year\'s Florida trip on file instead of resolving to last year\'s', async () => {
    db.seed('vacations', [
      trip('florida-2025', 'Florida', '2025-12-20', '2025-12-28', { destination: 'Orlando, Florida' }),
      // A one-day trip with no end date is over once its day has passed.
      trip('florida-day', 'Florida day trip', '2026-09-01', null, { destination: 'Clearwater, Florida' }),
    ]);
    const { findOrCreateVacation } = await import('@/lib/services/trips');
    const res = await findOrCreateVacation(scope(), { destination: 'Florida' });
    expect(res).toMatchObject({ ok: true, data: { created: true } });
    expect(res.ok && res.data.vacation.id).not.toMatch(/^florida-(2025|day)$/);
  });

  it('still finds a live trip the request names, including one under way', async () => {
    db.seed('vacations', [
      trip('florida-2025', 'Florida', '2025-12-20', '2025-12-28', { destination: 'Orlando, Florida' }),
      // Its last day is today: still under way.
      trip('florida-now', 'Florida again', '2026-10-20', TODAY, { destination: 'Tampa, Florida' }),
    ]);
    const { findOrCreateVacation } = await import('@/lib/services/trips');
    const res = await findOrCreateVacation(scope(), { destination: 'Florida' });
    expect(res).toMatchObject({ ok: true, data: { created: false, vacation: { id: 'florida-now' } } });
  });
});
