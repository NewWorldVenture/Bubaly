// A delayed flight and a cancelled hotel, in the only two places the answer
// can be wrong: the pure re-flow rules, and what the service actually writes.
//
// The behaviours pinned here are the ones a family would notice: a delay moves
// the plans that come AFTER the booking clears and leaves the earlier ones
// alone; a shift past midnight lands on the next day rather than at 25:30; a
// cancellation moves nothing and instead names what a PERSON has to rebook;
// "still on time" is a no-op that writes nothing and tells nobody. And the
// vocabulary: nothing in this feature may say a booking was rebooked, because
// nothing in this feature calls an airline.
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { addDays, replanDisruption, type ItineraryLike, type ReservationLike } from '@/lib/vacations/disruption';
import { planTripDisruption, reportTripDisruption } from '@/lib/services/trips';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const DAY = '2026-07-14';

function item(over: Partial<ItineraryLike> & { id: string; title: string }): ItineraryLike {
  return {
    day_id: `day-${DAY}`,
    day_date: DAY,
    kind: 'activity',
    day_part: 'afternoon',
    start_time: null,
    end_time: null,
    ...over,
  };
}

const flightInput = {
  kind: 'flight' as const,
  id: 'flight-1',
  label: 'BA 274',
  anchorDay: DAY,
  anchorTime: '14:00',
};

describe('replanDisruption — a delay', () => {
  const itinerary: ItineraryLike[] = [
    item({ id: 'morning', title: 'Museum', start_time: '09:00', end_time: '11:00', day_part: 'morning' }),
    item({ id: 'checkin', title: 'Hotel check-in', start_time: '15:00', end_time: '15:30' }),
    item({ id: 'dinner', title: 'Dinner', start_time: '19:00', end_time: '21:00', kind: 'meal', day_part: 'evening' }),
    item({ id: 'nextday', title: 'Beach', start_time: '10:00', end_time: '12:00', day_id: 'day-next', day_date: addDays(DAY, 1) }),
  ];

  it('moves only what comes after the flight was due to land', () => {
    const plan = replanDisruption({ ...flightInput, delayMinutes: 90 }, itinerary);
    expect(plan.noop).toBe(false);
    expect(plan.shiftedItems.map((s) => s.id)).toEqual(['checkin', 'dinner']);
    const checkin = plan.shiftedItems.find((s) => s.id === 'checkin')!;
    expect(checkin.toStart).toBe('16:30');
    expect(checkin.toEnd).toBe('17:00');
    expect(checkin.toDay).toBe(DAY);
    expect(checkin.rolledOvernight).toBe(false);
  });

  it('leaves the day before the disruption and the following day untouched', () => {
    const plan = replanDisruption({ ...flightInput, delayMinutes: 90 }, itinerary);
    expect(plan.shiftedItems.some((s) => s.id === 'morning')).toBe(false);
    expect(plan.shiftedItems.some((s) => s.id === 'nextday')).toBe(false);
  });

  it('rolls a shift past midnight onto the next calendar day instead of inventing 25:30', () => {
    const plan = replanDisruption({ ...flightInput, delayMinutes: 8 * 60 }, itinerary);
    const dinner = plan.shiftedItems.find((s) => s.id === 'dinner')!;
    expect(dinner.rolledOvernight).toBe(true);
    expect(dinner.toDay).toBe('2026-07-15');
    expect(dinner.toStart).toBe('03:00');
    expect(dinner.toEnd).toBe('05:00');
  });

  it('flags a reservation that falls inside the delay, and leaves a later one alone', () => {
    const reservations: ReservationLike[] = [
      { id: 'res-missed', name: 'Tapas at 15:00', day: DAY, time: '15:00' },
      { id: 'res-fine', name: 'Late show', day: DAY, time: '20:00' },
    ];
    const plan = replanDisruption({ ...flightInput, delayMinutes: 120 }, itinerary, reservations);
    expect(plan.toRebook.map((r) => r.id)).toEqual(['res-missed']);
    expect(plan.toRebook[0].reason).toBe('missed_window');
  });

  it('says what moved without ever claiming a rebooking', () => {
    const plan = replanDisruption({ ...flightInput, delayMinutes: 90 }, itinerary, [
      { id: 'res-missed', name: 'Tapas', day: DAY, time: '15:00' },
    ]);
    expect(plan.summary).toContain('delayed 90 minutes');
    expect(plan.summary).toContain('nothing was rebooked for you');
    expect(plan.summary).not.toMatch(/\brebooked (it|them|the)\b/i);
  });
});

describe('replanDisruption — a cancellation', () => {
  const itinerary: ItineraryLike[] = [
    item({ id: 'morning', title: 'Packing', start_time: '09:00', end_time: '10:00', day_part: 'morning' }),
    item({ id: 'tour', title: 'City tour', start_time: '16:00', end_time: '18:00' }),
  ];

  it('moves nothing and hands the flight plus the stranded plans to a person', () => {
    const plan = replanDisruption({ ...flightInput, cancelled: true }, itinerary, [
      { id: 'res-1', name: 'Dinner', day: DAY, time: '20:00' },
    ]);
    expect(plan.shiftedItems).toEqual([]);
    expect(plan.toRebook.map((r) => [r.kind, r.id])).toEqual([
      ['flight', 'flight-1'],
      ['itinerary_item', 'tour'],
      ['reservation', 'res-1'],
    ]);
    expect(plan.toRebook.every((r) => r.reason !== 'missed_window')).toBe(true);
    expect(plan.summary).toContain('was cancelled');
    expect(plan.summary).toContain('nothing was rebooked for you');
  });

  it('treats a lost hotel as a bed to find, not an itinerary to re-flow', () => {
    const plan = replanDisruption(
      { kind: 'lodging', id: 'stay-1', label: 'Hotel Arts', anchorDay: DAY, cancelled: true },
      itinerary,
      [{ id: 'res-1', name: 'Dinner', day: DAY, time: '20:00' }],
    );
    expect(plan.shiftedItems).toEqual([]);
    expect(plan.toRebook).toHaveLength(1);
    expect(plan.toRebook[0]).toMatchObject({ kind: 'lodging', id: 'stay-1', reason: 'cancelled' });
  });
});

describe('replanDisruption — nothing happened', () => {
  it('is a no-op for a zero delay and for a missing one', () => {
    for (const delay of [0, null, undefined]) {
      const plan = replanDisruption({ ...flightInput, delayMinutes: delay }, [
        item({ id: 'x', title: 'Anything', start_time: '16:00', end_time: '17:00' }),
      ]);
      expect(plan.noop).toBe(true);
      expect(plan.shiftedItems).toEqual([]);
      expect(plan.toRebook).toEqual([]);
      expect(plan.summary).toContain('still on time');
    }
  });
});

// ── the service half: what actually lands in the tables ──────────────────────

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
  db.seed('vacation_reservations', [{
    id: 'res-1', family_id: FAMILY, vacation_id: 'trip-1', kind: 'dining', name: 'Tapas bar',
    reserved_at: `${DAY}T15:00:00Z`, booked: true,
  }]);
  db.seed('vacation_itinerary_days', [
    { id: 'day-1', family_id: FAMILY, vacation_id: 'trip-1', day_date: DAY },
  ]);
  db.seed('vacation_itinerary_items', [
    { id: 'item-early', family_id: FAMILY, vacation_id: 'trip-1', day_id: 'day-1', kind: 'activity', day_part: 'morning', title: 'Airport', start_time: '09:00', end_time: '10:00', booked: false, sort_order: 0 },
    { id: 'item-late', family_id: FAMILY, vacation_id: 'trip-1', day_id: 'day-1', kind: 'activity', day_part: 'evening', title: 'Sagrada Familia', start_time: '16:00', end_time: '18:00', booked: true, sort_order: 1 },
  ]);
  return db;
}

function scopeFor(db: unknown): ServiceScope {
  return {
    db: db as SupabaseClient<Database>,
    familyId: FAMILY, userId: 'user-1', memberId: 'mem-1', role: 'parent', actorKind: 'member', tz: 'UTC',
  };
}

/** The same store, except that one table answers every query with an error — the fail-closed case. */
function withFailingTable(db: InMemorySupabase, failing: string): unknown {
  const reply = { data: null, error: { code: 'XX000', message: `${failing} unavailable`, details: null, hint: null }, count: null };
  const proxy: unknown = new Proxy({}, {
    get(_target, prop) {
      if (prop === 'then') {
        return (onFulfilled: (value: unknown) => unknown) => Promise.resolve(reply).then(onFulfilled);
      }
      return () => proxy;
    },
  });
  return { from: (name: string) => (name === failing ? proxy : db.from(name)) };
}

describe('reportTripDisruption', () => {
  it('moves the itinerary rows and records the disruption as a note item', async () => {
    const db = seeded();
    const res = await reportTripDisruption(scopeFor(db), 'trip-1', { kind: 'flight', bookingId: 'flight-1', delayMinutes: 120 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.applied.shifted).toBe(1);
    expect(res.data.applied.noteItemId).not.toBeNull();

    const items = db.table('vacation_itinerary_items') as Record<string, unknown>[];
    const late = items.find((r) => r.id === 'item-late')!;
    expect(late.start_time).toBe('18:00');
    expect(late.end_time).toBe('20:00');
    const early = items.find((r) => r.id === 'item-early')!;
    expect(early.start_time).toBe('09:00');

    // The reservation inside the delay window is named, never touched.
    expect(res.data.plan.toRebook.map((r) => r.id)).toEqual(['res-1']);

    const note = items.find((r) => r.kind === 'note')!;
    expect(note.title).toBe('Disruption: BA 274');
    expect(String(note.notes)).toContain('nothing was rebooked for you');
  });

  it('writes nothing at all when the booking is still on time', async () => {
    const db = seeded();
    const before = (db.table('vacation_itinerary_items') as unknown[]).length;
    const res = await reportTripDisruption(scopeFor(db), 'trip-1', { kind: 'flight', bookingId: 'flight-1', delayMinutes: 0 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.plan.noop).toBe(true);
    expect(res.data.applied).toEqual({ shifted: 0, noteItemId: null });
    expect((db.table('vacation_itinerary_items') as unknown[]).length).toBe(before);
  });

  it('creates the day row a cross-midnight shift lands on rather than dropping the item', async () => {
    const db = seeded();
    const res = await reportTripDisruption(scopeFor(db), 'trip-1', { kind: 'flight', bookingId: 'flight-1', delayMinutes: 10 * 60 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const days = db.table('vacation_itinerary_days') as Record<string, unknown>[];
    const rolled = days.find((d) => d.day_date === '2026-07-15');
    expect(rolled, 'the next day was created for the rolled item').toBeDefined();
    const late = (db.table('vacation_itinerary_items') as Record<string, unknown>[]).find((r) => r.id === 'item-late')!;
    expect(late.day_id).toBe(rolled!.id);
    expect(late.start_time).toBe('02:00');
  });

  it('refuses a booking that is not on this trip instead of guessing', async () => {
    const db = seeded();
    const res = await reportTripDisruption(scopeFor(db), 'trip-1', { kind: 'flight', bookingId: 'flight-nope', delayMinutes: 30 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain('not on this trip');
  });
});

describe('planTripDisruption', () => {
  it('changes nothing — it is the read-only half the AI tool calls', async () => {
    const db = seeded();
    const before = JSON.stringify(db.table('vacation_itinerary_items'));
    const res = await planTripDisruption(scopeFor(db), 'trip-1', { kind: 'flight', bookingId: 'flight-1', delayMinutes: 120 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.plan.shiftedItems).toHaveLength(1);
    expect(JSON.stringify(db.table('vacation_itinerary_items'))).toBe(before);
  });

  it('fails closed when a trip table cannot be read, rather than reporting an empty itinerary', async () => {
    const db = seeded();
    const res = await planTripDisruption(
      scopeFor(withFailingTable(db, 'vacation_itinerary_items')),
      'trip-1',
      { kind: 'flight', bookingId: 'flight-1', delayMinutes: 120 },
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBeTruthy();
  });
});
