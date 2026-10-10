// A reported flight delay moves the family's plans once.
//
// `reportTripDisruption` moved every itinerary item that starts on the arrival
// day at or after the flight's `arrive_at` forward by the delay — and left the
// flight where it was. So the trip went on saying the flight lands at 14:00
// while the plans had been moved for a 16:00 landing, and every further report
// anchored at the stale 14:00 and moved the same plans again: two parents
// reporting the same two-hour delay, a second tab, or a retry, and dinner was
// four hours late. A failed item move returned an error with some plans already
// moved, so the retry the error invited moved those twice too.
//
// Now the delay moves the flight's own times, as a compare-and-set on the times
// the plan was read from — a concurrent duplicate is refused before it moves
// anything — and a failure restores what had moved, so the error means nothing
// changed. Stripe-free, provider-free: an in-memory table set, ids synthetic.
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { reportTripDisruption } from '@/lib/services/trips';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const DAY = '2026-07-14';
const FAMILY = 'fam-1';

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
    depart_airport: 'LHR', arrive_airport: 'BCN', depart_at: `${DAY}T11:00:00Z`, arrive_at: `${DAY}T14:00:00Z`, booked: true,
  }]);
  db.seed('vacation_lodging', [{
    id: 'stay-1', family_id: FAMILY, vacation_id: 'trip-1', name: 'Hotel Arts', check_in: DAY, check_out: '2026-07-20',
  }]);
  db.seed('vacation_itinerary_days', [
    { id: 'day-1', family_id: FAMILY, vacation_id: 'trip-1', day_date: DAY },
  ]);
  db.seed('vacation_itinerary_items', [
    { id: 'item-early', family_id: FAMILY, vacation_id: 'trip-1', day_id: 'day-1', kind: 'activity', day_part: 'morning', title: 'Airport', start_time: '09:00', end_time: '10:00', booked: false, sort_order: 0 },
    { id: 'item-tour', family_id: FAMILY, vacation_id: 'trip-1', day_id: 'day-1', kind: 'activity', day_part: 'evening', title: 'Sagrada Familia', start_time: '16:00', end_time: '18:00', booked: true, sort_order: 1 },
    { id: 'item-dinner', family_id: FAMILY, vacation_id: 'trip-1', day_id: 'day-1', kind: 'meal', day_part: 'evening', title: 'Dinner', start_time: '19:00', end_time: '21:00', booked: false, sort_order: 2 },
  ]);
  return db;
}

function scopeFor(db: unknown): ServiceScope {
  return {
    db: db as SupabaseClient<Database>,
    familyId: FAMILY, userId: 'user-1', memberId: 'mem-1', role: 'parent', actorKind: 'member', tz: 'UTC',
  };
}

type Write = { table: string; op: string | null; filters: Record<string, unknown>; payload: unknown };

/**
 * The same store, except that a write `refuse` picks answers an error instead
 * of landing — the "this one update failed" case, which the fake has no switch for.
 */
function refusing(db: InMemorySupabase, refuse: (write: Write) => boolean): unknown {
  const reply = { data: null, error: { code: 'XX000', message: 'synthetic write failure', details: null, hint: null }, count: null, status: 500, statusText: 'error' };
  const wrap = (builder: object, state: Write): unknown => new Proxy(builder, {
    get(target, prop) {
      const value = Reflect.get(target, prop) as unknown;
      if (prop === 'then' && state.op && state.op !== 'select' && refuse(state)) {
        return (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) => Promise.resolve(reply).then(onFulfilled, onRejected);
      }
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const next: Write = { ...state, filters: { ...state.filters } };
        if (prop === 'update' || prop === 'insert' || prop === 'delete' || prop === 'upsert') { next.op = prop; next.payload = args[0]; }
        else if (prop === 'select' && !state.op) next.op = 'select';
        if (prop === 'eq') next.filters[String(args[0])] = args[1];
        const out = (value as (...a: unknown[]) => unknown).apply(target, args);
        return out && typeof out === 'object' ? wrap(out as object, next) : out;
      };
    },
  });
  return { from: (table: string) => wrap(db.from(table) as object, { table, op: null, filters: {}, payload: null }) };
}

const items = (db: InMemorySupabase) => db.table('vacation_itinerary_items') as Record<string, unknown>[];
const itemById = (db: InMemorySupabase, id: string) => items(db).find((r) => r.id === id)!;
const flight = (db: InMemorySupabase) => (db.table('vacation_flights') as Record<string, unknown>[])[0];
const notes = (db: InMemorySupabase) => items(db).filter((r) => r.kind === 'note');
const instant = (value: unknown) => new Date(String(value)).toISOString();

describe('a reported flight delay', () => {
  it('moves the flight itself, so the trip shows when it now lands', async () => {
    const db = seeded();
    const res = await reportTripDisruption(scopeFor(db), 'trip-1', { kind: 'flight', bookingId: 'flight-1', delayMinutes: 120 });
    expect(res.ok).toBe(true);
    expect(instant(flight(db).arrive_at)).toBe(`${DAY}T16:00:00.000Z`);
    expect(instant(flight(db).depart_at)).toBe(`${DAY}T13:00:00.000Z`);
    expect(itemById(db, 'item-tour').start_time).toBe('18:00');
  });

  it('moves the plans once when the same delay is reported twice at the same moment', async () => {
    const db = seeded();
    const report = () => reportTripDisruption(scopeFor(db), 'trip-1', { kind: 'flight', bookingId: 'flight-1', delayMinutes: 120 });
    const [a, b] = await Promise.all([report(), report()]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const refused = a.ok ? b : a;
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toMatch(/changed/i);
    expect(itemById(db, 'item-tour').start_time, 'two hours late, not four').toBe('18:00');
    expect(itemById(db, 'item-dinner').start_time).toBe('21:00');
    expect(instant(flight(db).arrive_at)).toBe(`${DAY}T16:00:00.000Z`);
    expect(notes(db)).toHaveLength(1);
  });

  it.each([
    ['only its landing time', { depart_at: null }],
    ['only its departure time', { arrive_at: null }],
  ])('refuses the duplicate for a flight with %s on file', async (_label, missing) => {
    const db = seeded();
    Object.assign((db.table('vacation_flights') as Record<string, unknown>[])[0], missing);
    const report = () => reportTripDisruption(scopeFor(db), 'trip-1', { kind: 'flight', bookingId: 'flight-1', delayMinutes: 120 });
    const [a, b] = await Promise.all([report(), report()]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(itemById(db, 'item-tour').start_time, 'two hours later, once').toBe('18:00');
    expect(notes(db)).toHaveLength(1);
  });

  it('anchors a later report at the new landing time, so the plans keep their distance from it', async () => {
    const db = seeded();
    expect((await reportTripDisruption(scopeFor(db), 'trip-1', { kind: 'flight', bookingId: 'flight-1', delayMinutes: 120 })).ok).toBe(true);
    expect((await reportTripDisruption(scopeFor(db), 'trip-1', { kind: 'flight', bookingId: 'flight-1', delayMinutes: 60 })).ok).toBe(true);
    expect(instant(flight(db).arrive_at)).toBe(`${DAY}T17:00:00.000Z`);
    // Booked two hours after landing, still two hours after landing.
    expect(itemById(db, 'item-tour').start_time).toBe('19:00');
    expect(itemById(db, 'item-early').start_time).toBe('09:00');
  });

  it('puts everything back when one plan cannot be moved, so the retry the error invites starts clean', async () => {
    const db = seeded();
    const client = refusing(db, (w) => w.table === 'vacation_itinerary_items' && w.op === 'update' && w.filters.id === 'item-dinner' && (w.payload as Record<string, unknown>)?.start_time === '21:00');
    const res = await reportTripDisruption(scopeFor(client), 'trip-1', { kind: 'flight', bookingId: 'flight-1', delayMinutes: 120 });
    expect(res.ok).toBe(false);
    expect(itemById(db, 'item-tour').start_time, 'the plan that had moved is back').toBe('16:00');
    expect(itemById(db, 'item-tour').end_time).toBe('18:00');
    expect(itemById(db, 'item-dinner').start_time).toBe('19:00');
    expect(instant(flight(db).arrive_at)).toBe(`${DAY}T14:00:00.000Z`);
    expect(notes(db)).toHaveLength(0);

    // And the retry moves each plan once.
    const retry = await reportTripDisruption(scopeFor(db), 'trip-1', { kind: 'flight', bookingId: 'flight-1', delayMinutes: 120 });
    expect(retry.ok).toBe(true);
    expect(itemById(db, 'item-tour').start_time).toBe('18:00');
    expect(itemById(db, 'item-dinner').start_time).toBe('21:00');
  });

  it('puts everything back when the record of the disruption cannot be written', async () => {
    const db = seeded();
    const client = refusing(db, (w) => w.table === 'vacation_itinerary_items' && w.op === 'insert');
    const res = await reportTripDisruption(scopeFor(client), 'trip-1', { kind: 'flight', bookingId: 'flight-1', delayMinutes: 120 });
    expect(res.ok).toBe(false);
    expect(itemById(db, 'item-tour').start_time).toBe('16:00');
    expect(itemById(db, 'item-dinner').start_time).toBe('19:00');
    expect(instant(flight(db).arrive_at)).toBe(`${DAY}T14:00:00.000Z`);
  });

  it('moves nothing when the flight cannot be moved', async () => {
    const db = seeded();
    const client = refusing(db, (w) => w.table === 'vacation_flights' && w.op === 'update');
    const res = await reportTripDisruption(scopeFor(client), 'trip-1', { kind: 'flight', bookingId: 'flight-1', delayMinutes: 120 });
    expect(res.ok).toBe(false);
    expect(itemById(db, 'item-tour').start_time).toBe('16:00');
    expect(notes(db)).toHaveLength(0);
  });
});

describe('what a delay report still does not touch (controls)', () => {
  it('moves no booking for a cancellation, and still records it', async () => {
    const db = seeded();
    const res = await reportTripDisruption(scopeFor(db), 'trip-1', { kind: 'flight', bookingId: 'flight-1', cancelled: true });
    expect(res.ok).toBe(true);
    expect(instant(flight(db).arrive_at)).toBe(`${DAY}T14:00:00.000Z`);
    expect(itemById(db, 'item-tour').start_time).toBe('16:00');
    expect(notes(db)).toHaveLength(1);
  });

  it('still re-flows around a late hotel check-in, whose date has no time to move', async () => {
    const db = seeded();
    const res = await reportTripDisruption(scopeFor(db), 'trip-1', { kind: 'lodging', bookingId: 'stay-1', delayMinutes: 60 });
    expect(res.ok).toBe(true);
    expect(itemById(db, 'item-tour').start_time).toBe('17:00');
    expect((db.table('vacation_lodging') as Record<string, unknown>[])[0].check_in).toBe(DAY);
  });
});
