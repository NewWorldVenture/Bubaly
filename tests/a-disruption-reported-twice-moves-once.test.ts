import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { BOOKING_CHANGED_CODE, reportTripDisruption } from '@/lib/services/trips';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

// SRV-001 census (#771 comment 5981946753). A disruption report moves every
// itinerary item after the booking by the delay, and recorded nothing that
// said it had: the flight kept its time and the items carried no mark. So
// the same report made twice — a second click on a form that stays filled in,
// a retry after a lost answer, a second parent with the page open — moved the
// same plans again, and a failure half way left half of them moved for the
// retry to move a second time. A report is now made against the booking's
// version (`updated_at`) and claims it before anything moves.

const DAY = '2026-07-14';
const FAMILY = 'fam-1';
const V0 = '2026-07-01T09:00:00.000Z';

function seeded() {
  const db = createInMemorySupabase({
    defaults: {
      vacation_itinerary_items: { booked: false, sort_order: 0, member_ids: [], notes: null },
      vacation_itinerary_days: { title: null, summary: null },
    },
  });
  db.seed('vacations', [{
    id: 'trip-1', family_id: FAMILY, title: 'Barcelona', destination: 'Barcelona', kind: 'flight', status: 'booked',
    start_date: DAY, end_date: '2026-07-20', timezone: 'UTC', is_international: true,
  }]);
  db.seed('vacation_flights', [{
    id: 'flight-1', family_id: FAMILY, vacation_id: 'trip-1', airline: 'BA', flight_number: '274',
    depart_airport: 'LHR', arrive_airport: 'BCN', depart_at: `${DAY}T11:00:00.000Z`, arrive_at: `${DAY}T14:00:00.000Z`, booked: true,
    updated_at: V0,
  }]);
  db.seed('vacation_itinerary_days', [{ id: 'day-1', family_id: FAMILY, vacation_id: 'trip-1', day_date: DAY }]);
  db.seed('vacation_itinerary_items', [
    { id: 'early', family_id: FAMILY, vacation_id: 'trip-1', day_id: 'day-1', kind: 'activity', day_part: 'morning', title: 'Airport', start_time: '09:00', end_time: '10:00' },
    { id: 'checkin', family_id: FAMILY, vacation_id: 'trip-1', day_id: 'day-1', kind: 'activity', day_part: 'afternoon', title: 'Hotel check-in', start_time: '15:00', end_time: '15:30' },
    { id: 'tour', family_id: FAMILY, vacation_id: 'trip-1', day_id: 'day-1', kind: 'activity', day_part: 'evening', title: 'Sagrada Familia', start_time: '17:00', end_time: '19:00' },
  ]);
  return db;
}

const scopeFor = (db: unknown): ServiceScope => ({
  db: db as SupabaseClient<Database>,
  familyId: FAMILY, userId: 'user-1', memberId: 'mem-1', role: 'parent', actorKind: 'member', tz: 'UTC',
});

const row = (db: InMemorySupabase, table: string, id: string) => (db.table(table) as Record<string, unknown>[]).find((r) => r.id === id)!;
const times = (db: InMemorySupabase) => ['early', 'checkin', 'tour'].map((id) => row(db, 'vacation_itinerary_items', id).start_time);
const notes = (db: InMemorySupabase) => (db.table('vacation_itinerary_items') as Record<string, unknown>[]).filter((r) => r.kind === 'note');
const late = (minutes: number) => ({ kind: 'flight' as const, bookingId: 'flight-1', delayMinutes: minutes });

/** The store, with every UPDATE of one itinerary item failing. */
function failingItemUpdate(db: InMemorySupabase, itemId: string): unknown {
  return {
    from(table: string) {
      const builder = db.from(table) as unknown as Record<string, (...a: unknown[]) => unknown>;
      if (table !== 'vacation_itinerary_items') return builder;
      const update = builder.update.bind(builder);
      builder.update = (patch: unknown) => {
        const q = update(patch) as Record<string, (...a: unknown[]) => unknown>;
        const eq = q.eq.bind(q);
        q.eq = (col: unknown, val: unknown) => {
          if (col === 'id' && val === itemId) {
            const reply = { data: null, error: { code: '57014', message: 'statement timeout', details: null, hint: null } };
            const dead: Record<string, unknown> = {};
            for (const m of ['eq', 'select', 'is', 'single', 'maybeSingle']) dead[m] = () => dead;
            dead.then = (ok: (v: unknown) => unknown) => Promise.resolve(reply).then(ok);
            return dead;
          }
          return eq(col, val);
        };
        return q;
      };
      return builder;
    },
  };
}

describe('a disruption report moves the itinerary once', () => {
  it('the same report submitted twice moves the plans once, and the second is refused', async () => {
    const db = seeded();
    const first = await reportTripDisruption(scopeFor(db), 'trip-1', late(120), V0);
    expect(first.ok).toBe(true);
    expect(times(db)).toEqual(['09:00', '17:00', '19:00']);

    const again = await reportTripDisruption(scopeFor(db), 'trip-1', late(120), V0);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.code).toBe(BOOKING_CHANGED_CODE);
    expect(times(db)).toEqual(['09:00', '17:00', '19:00']);
    expect(notes(db)).toHaveLength(1);
  });

  it('two reports racing on the same form move the plans once', async () => {
    const db = seeded();
    const results = await Promise.all([
      reportTripDisruption(scopeFor(db), 'trip-1', late(120), V0),
      reportTripDisruption(scopeFor(db), 'trip-1', late(120), V0),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(times(db)).toEqual(['09:00', '17:00', '19:00']);
    expect(notes(db)).toHaveLength(1);
  });

  it('the flight lands when it now lands, so a later report adds to it rather than repeating it', async () => {
    const db = seeded();
    await reportTripDisruption(scopeFor(db), 'trip-1', late(120), V0);
    const flight = row(db, 'vacation_flights', 'flight-1');
    expect(flight.arrive_at).toBe(`${DAY}T16:00:00.000Z`);
    expect(flight.depart_at).toBe(`${DAY}T11:00:00.000Z`);
    expect(flight.updated_at).not.toBe(V0);

    // "Another hour" against the booking as it now stands.
    const more = await reportTripDisruption(scopeFor(db), 'trip-1', late(60), String(flight.updated_at));
    expect(more.ok).toBe(true);
    expect(times(db)).toEqual(['09:00', '18:00', '20:00']);
    expect(row(db, 'vacation_flights', 'flight-1').arrive_at).toBe(`${DAY}T17:00:00.000Z`);
  });

  it('a report made against a booking someone has since changed moves nothing', async () => {
    const db = seeded();
    const res = await reportTripDisruption(scopeFor(db), 'trip-1', late(120), '2026-06-30T00:00:00.000Z');
    expect(res).toMatchObject({ ok: false, code: BOOKING_CHANGED_CODE });
    expect(times(db)).toEqual(['09:00', '15:00', '17:00']);
    expect(row(db, 'vacation_flights', 'flight-1').updated_at).toBe(V0);
    expect(notes(db)).toHaveLength(0);
  });

  it('a failure half way puts back what moved and the booking, so the retry moves each plan once', async () => {
    const db = seeded();
    const failed = await reportTripDisruption(scopeFor(failingItemUpdate(db, 'tour')), 'trip-1', late(120), V0);
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error).toContain('Nothing was changed');
    expect(times(db)).toEqual(['09:00', '15:00', '17:00']);
    expect(row(db, 'vacation_flights', 'flight-1').arrive_at).toBe(`${DAY}T14:00:00.000Z`);
    expect(notes(db)).toHaveLength(0);

    const retry = await reportTripDisruption(scopeFor(db), 'trip-1', late(120), String(row(db, 'vacation_flights', 'flight-1').updated_at));
    expect(retry.ok).toBe(true);
    expect(times(db)).toEqual(['09:00', '17:00', '19:00']);
  });

  it('a plan someone re-timed while the report ran is theirs, not pushed again', async () => {
    const db = seeded();
    // The item moves between the report's read and its write.
    const racing = {
      from(table: string) {
        const builder = db.from(table) as unknown as Record<string, (...a: unknown[]) => unknown>;
        if (table === 'vacation_flights') {
          const update = builder.update.bind(builder);
          builder.update = (patch: unknown) => {
            row(db, 'vacation_itinerary_items', 'tour').start_time = '18:30';
            return update(patch);
          };
        }
        return builder;
      },
    };
    const res = await reportTripDisruption(scopeFor(racing), 'trip-1', late(120), V0);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.applied.shifted).toBe(1);
    expect(times(db)).toEqual(['09:00', '17:00', '18:30']);
  });

  it('control: a stay\'s report restamps the stay and moves nothing on its own row', async () => {
    const db = seeded();
    db.seed('vacation_lodging', [{ id: 'stay-1', family_id: FAMILY, vacation_id: 'trip-1', name: 'Hotel Arts', check_in: DAY, check_out: '2026-07-20', updated_at: V0 }]);
    const res = await reportTripDisruption(scopeFor(db), 'trip-1', { kind: 'lodging', bookingId: 'stay-1', delayMinutes: 60 }, V0);
    expect(res.ok).toBe(true);
    const stay = row(db, 'vacation_lodging', 'stay-1');
    expect(stay.check_in).toBe(DAY);
    expect(stay.updated_at).not.toBe(V0);
    expect(times(db)).toEqual(['09:00', '16:00', '18:00']);
    const again = await reportTripDisruption(scopeFor(db), 'trip-1', { kind: 'lodging', bookingId: 'stay-1', delayMinutes: 60 }, V0);
    expect(again).toMatchObject({ ok: false, code: BOOKING_CHANGED_CODE });
    expect(times(db)).toEqual(['09:00', '16:00', '18:00']);
  });
});
