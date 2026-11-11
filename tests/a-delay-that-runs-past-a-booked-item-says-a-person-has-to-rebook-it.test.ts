// `ItineraryLike.booked` is declared as the column "that decides whether a
// person must call someone", and the trips service supplies it. The re-flow
// never read it. So when a flight ran late, a BOOKED itinerary item that fell
// inside the delay (a ticketed tour, a timed museum entry) was shifted like the
// family's own picnic and nothing more was said: the summary that is persisted
// on the itinerary and sent to the family read "Moved 1 itinerary item to
// match. No booking needs rebooking." for a ticket a third party still holds
// at the original time.
//
// The row still moves with the rest of the day (the re-flow's other tests pin
// that, and its new slot is where the family could now use it), but it is no
// longer moved SILENTLY: it is named in `toRebook` at the time the ticket
// says, exactly as a `vacation_reservations` row in the same window already
// was, and the summary counts it.
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { replanDisruption, type ItineraryLike } from '@/lib/vacations/disruption';
import { reportTripDisruption } from '@/lib/services/trips';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const DAY = '2026-07-14';

function item(over: Partial<ItineraryLike> & { id: string; title: string }): ItineraryLike {
  return { day_id: `day-${DAY}`, day_date: DAY, kind: 'activity', day_part: 'afternoon', start_time: null, end_time: null, ...over };
}

const flight = { kind: 'flight' as const, id: 'flight-1', label: 'BA 274', anchorDay: DAY, anchorTime: '14:00' };

describe('replanDisruption, a delay that runs past a booked itinerary item', () => {
  const itinerary: ItineraryLike[] = [
    item({ id: 'tour', title: 'Sagrada Familia timed entry', start_time: '15:00', end_time: '16:30', booked: true }),
    item({ id: 'picnic', title: 'Picnic in the park', start_time: '15:15', end_time: '16:00', booked: false }),
    item({ id: 'walk', title: 'Evening walk', start_time: '18:00', end_time: '19:00' }),
  ];

  it('names the booked item for a person to rebook, at the time the ticket still says', () => {
    const plan = replanDisruption({ ...flight, delayMinutes: 120 }, itinerary);
    expect(plan.toRebook).toEqual([
      { kind: 'itinerary_item', id: 'tour', title: 'Sagrada Familia timed entry', reason: 'missed_window', when: '15:00' },
    ]);
  });

  it('records where the row moved from, so the ticketed time is not lost when the row is shifted', () => {
    const plan = replanDisruption({ ...flight, delayMinutes: 120 }, itinerary);
    expect(plan.shiftedItems.map((s) => [s.id, s.fromStart, s.toStart])).toEqual(
      [['tour', '15:00', '17:00'], ['picnic', '15:15', '17:15'], ['walk', '18:00', '20:00']]);
  });

  it('counts it in the summary, which no longer says no booking needs rebooking', () => {
    const plan = replanDisruption({ ...flight, delayMinutes: 120 }, itinerary);
    expect(plan.summary).toBe(
      'BA 274 is delayed 120 minutes on 2026-07-14. Moved 3 itinerary items to match. '
      + '1 booking still needs a person to rebook — nothing was rebooked for you.');
  });

  it('with only the booked item on the day, the summary is the one the finding quoted, corrected', () => {
    const plan = replanDisruption({ ...flight, delayMinutes: 120 }, [itinerary[0]]);
    expect(plan.summary).toBe(
      'BA 274 is delayed 120 minutes on 2026-07-14. Moved 1 itinerary item to match. '
      + '1 booking still needs a person to rebook — nothing was rebooked for you.');
    expect(plan.summary).not.toContain('No booking needs rebooking');
  });

  it('counts a missed reservation and a missed booked item together', () => {
    const plan = replanDisruption({ ...flight, delayMinutes: 120 }, [itinerary[0]],
      [{ id: 'res-1', name: 'Tapas bar', day: DAY, time: '15:30' }]);
    expect(plan.toRebook.map((r) => [r.kind, r.id])).toEqual([['itinerary_item', 'tour'], ['reservation', 'res-1']]);
    expect(plan.summary).toContain('2 bookings still need a person to rebook');
  });

  it('reads the window as the reservations do: at the landing time is missed, at the new arrival is not', () => {
    const edges: ItineraryLike[] = [
      item({ id: 'at-landing', title: 'Airport transfer', start_time: '14:00', booked: true }),
      item({ id: 'last-minute', title: 'Harbour cruise', start_time: '15:59', booked: true }),
      item({ id: 'at-arrival', title: 'Cooking class', start_time: '16:00', end_time: '17:00', booked: true }),
    ];
    const plan = replanDisruption({ ...flight, delayMinutes: 120 }, edges);
    expect(plan.toRebook.map((r) => [r.id, r.when])).toEqual([['at-landing', '14:00'], ['last-minute', '15:59']]);
  });

  it('an item that is not booked, or says nothing either way, is still the family\'s to move', () => {
    const own: ItineraryLike[] = [
      item({ id: 'unbooked', title: 'Beach', start_time: '15:00', booked: false }),
      item({ id: 'unknown', title: 'Market', start_time: '15:30', booked: null }),
      item({ id: 'absent', title: 'Gelato', start_time: '15:45' }),
    ];
    const plan = replanDisruption({ ...flight, delayMinutes: 120 }, own);
    expect(plan.toRebook).toEqual([]);
    expect(plan.shiftedItems.map((s) => s.id)).toEqual(['unbooked', 'unknown', 'absent']);
    expect(plan.summary).toContain('No booking needs rebooking.');
  });
});

describe('reportTripDisruption, the same delay as the tables see it', () => {
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
    db.seed('vacation_itinerary_days', [{ id: 'day-1', family_id: FAMILY, vacation_id: 'trip-1', day_date: DAY }]);
    db.seed('vacation_itinerary_items', [
      { id: 'item-tour', family_id: FAMILY, vacation_id: 'trip-1', day_id: 'day-1', kind: 'activity', day_part: 'afternoon', title: 'Sagrada Familia timed entry', start_time: '15:00', end_time: '16:30', booked: true, sort_order: 0 },
      { id: 'item-picnic', family_id: FAMILY, vacation_id: 'trip-1', day_id: 'day-1', kind: 'activity', day_part: 'afternoon', title: 'Picnic', start_time: '15:15', end_time: '16:00', booked: false, sort_order: 1 },
    ]);
    return db;
  }

  it('names the booked row with its ticketed time and writes the honest note', async () => {
    const db = seeded();
    const scope: ServiceScope = {
      db: db as unknown as SupabaseClient<Database>,
      familyId: FAMILY, userId: 'user-1', memberId: 'mem-1', role: 'parent', actorKind: 'member', tz: 'UTC',
    };
    const res = await reportTripDisruption(scope, 'trip-1', { kind: 'flight', bookingId: 'flight-1', delayMinutes: 120 });
    if (!res.ok) throw new Error(res.error);
    expect(res.data.applied.shifted).toBe(2);
    expect(res.data.plan.toRebook).toEqual([
      { kind: 'itinerary_item', id: 'item-tour', title: 'Sagrada Familia timed entry', reason: 'missed_window', when: '15:00' },
    ]);

    const rows = db.table('vacation_itinerary_items') as Record<string, unknown>[];
    const tour = rows.find((r) => r.id === 'item-tour')!;
    expect([tour.start_time, tour.end_time, tour.booked]).toEqual(['17:00', '18:30', true]);
    const picnic = rows.find((r) => r.id === 'item-picnic')!;
    expect([picnic.start_time, picnic.end_time]).toEqual(['17:15', '18:00']);

    const note = rows.find((r) => r.kind === 'note')!;
    expect(String(note.notes)).toContain('1 booking still needs a person to rebook');
    expect(String(note.notes)).not.toContain('No booking needs rebooking');
  });
});
