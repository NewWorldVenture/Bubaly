import { describe, it, expect } from 'vitest';
import {
  shortTime, sortRides, groupByDate, driverConflicts, upcomingRides,
  needsDriverCount, assessDriverSchedule, rideWindow, type RideLike,
} from '@/lib/rides/schedule';

const ride = (over: Partial<RideLike>): RideLike => ({
  id: Math.random().toString(36).slice(2),
  title: 'Ride', ride_date: '2026-06-22', pickup_time: '08:00',
  driver_id: 'd1', rider_ids: [], status: 'planned', ...over,
});

describe('shortTime', () => {
  it('normalises and tolerates null', () => {
    expect(shortTime('08:00:00')).toBe('08:00');
    expect(shortTime(null)).toBe('');
  });
});

describe('sortRides', () => {
  it('orders by date then time, untimed rides last in a day', () => {
    const a = ride({ id: 'a', ride_date: '2026-06-22', pickup_time: '15:00' });
    const b = ride({ id: 'b', ride_date: '2026-06-22', pickup_time: '08:00' });
    const c = ride({ id: 'c', ride_date: '2026-06-22', pickup_time: null });
    const d = ride({ id: 'd', ride_date: '2026-06-21', pickup_time: '23:00' });
    expect(sortRides([a, b, c, d]).map((r) => r.id)).toEqual(['d', 'b', 'a', 'c']);
  });
});

describe('groupByDate', () => {
  it('buckets rides into ordered date groups', () => {
    const groups = groupByDate([
      ride({ id: 'a', ride_date: '2026-06-23' }),
      ride({ id: 'b', ride_date: '2026-06-22', pickup_time: '07:00' }),
      ride({ id: 'c', ride_date: '2026-06-22', pickup_time: '09:00' }),
    ]);
    expect(groups.map(([d]) => d)).toEqual(['2026-06-22', '2026-06-23']);
    expect(groups[0][1].map((r) => r.id)).toEqual(['b', 'c']);
  });
});

describe('driverConflicts', () => {
  it('flags a driver double-booked at the same date+time', () => {
    const a = ride({ id: 'a', driver_id: 'mom', ride_date: '2026-06-22', pickup_time: '08:00' });
    const b = ride({ id: 'b', driver_id: 'mom', ride_date: '2026-06-22', pickup_time: '08:00' });
    const c = ride({ id: 'c', driver_id: 'dad', ride_date: '2026-06-22', pickup_time: '08:00' });
    const conflicts = driverConflicts([a, b, c]);
    expect(conflicts.has('a')).toBe(true);
    expect(conflicts.has('b')).toBe(true);
    expect(conflicts.has('c')).toBe(false);
  });

  it('ignores cancelled rides and rides without a driver/time', () => {
    const a = ride({ id: 'a', driver_id: 'mom', pickup_time: '08:00', status: 'cancelled' });
    const b = ride({ id: 'b', driver_id: 'mom', pickup_time: '08:00' });
    const c = ride({ id: 'c', driver_id: null, pickup_time: '08:00' });
    expect(driverConflicts([a, b, c]).size).toBe(0);
  });
});

describe('upcomingRides', () => {
  it('keeps today+future non-finished rides, sorted', () => {
    const past = ride({ id: 'p', ride_date: '2026-06-01' });
    const today = ride({ id: 't', ride_date: '2026-06-21', pickup_time: '10:00' });
    const future = ride({ id: 'f', ride_date: '2026-06-25' });
    const done = ride({ id: 'd', ride_date: '2026-06-26', status: 'completed' });
    const out = upcomingRides([past, today, future, done], '2026-06-21');
    expect(out.map((r) => r.id)).toEqual(['t', 'f']);
  });
});

describe('recorded driver windows', () => {
  it('flags different pickups inside a recorded ride window', () => {
    const result = assessDriverSchedule([
      ride({ id: 'a', pickup_time: '08:00', dropoff_time: '09:00' }),
      ride({ id: 'b', pickup_time: '08:30', dropoff_time: '08:45' }),
    ]);
    expect([...result.conflicts].sort()).toEqual(['a', 'b']);
    expect(result.incompleteTiming.size).toBe(0);
  });

  it('retains proven overlap when the later drop-off is unknown', () => {
    const result = assessDriverSchedule([
      ride({ id: 'a', pickup_time: '08:00', dropoff_time: '09:00' }),
      ride({ id: 'b', pickup_time: '08:30', dropoff_time: null }),
    ]);
    expect([...result.conflicts].sort()).toEqual(['a', 'b']);
    expect([...result.incompleteTiming]).toEqual(['b']);
  });

  it('does not invent a duration for an unknown earlier drop-off', () => {
    const result = assessDriverSchedule([
      ride({ id: 'a', pickup_time: '08:00', dropoff_time: null }),
      ride({ id: 'b', pickup_time: '08:30', dropoff_time: '09:00' }),
    ]);
    expect(result.conflicts.size).toBe(0);
    expect([...result.incompleteTiming]).toEqual(['a']);
  });

  it('keeps touching windows distinct without adding a fictional travel buffer', () => {
    expect(driverConflicts([
      ride({ id: 'a', pickup_time: '08:00', dropoff_time: '08:30' }),
      ride({ id: 'b', pickup_time: '08:30', dropoff_time: '09:00' }),
    ]).size).toBe(0);
  });

  it('separates drivers and dates and excludes completed or cancelled rides', () => {
    const result = assessDriverSchedule([
      ride({ id: 'a', pickup_time: '08:00', dropoff_time: '09:00' }),
      ride({ id: 'b', driver_id: 'd2', pickup_time: '08:30', dropoff_time: '09:00' }),
      ride({ id: 'c', ride_date: '2026-06-23', pickup_time: '08:30', dropoff_time: '09:00' }),
      ride({ id: 'done', status: 'completed' }),
      ride({ id: 'cancelled', status: 'cancelled' }),
      ride({ id: 'unassigned', driver_id: null }),
    ]);
    expect(result.conflicts.size).toBe(0);
    expect(result.incompleteTiming.size).toBe(0);
  });

  it.each([
    { pickup_time: null, dropoff_time: '09:00' },
    { pickup_time: '25:00', dropoff_time: '09:00' },
    { pickup_time: '08:60', dropoff_time: '09:00' },
    { pickup_time: '08:00', dropoff_time: '08:00' },
    { pickup_time: '23:30', dropoff_time: '00:30' },
    { pickup_time: '08:00', dropoff_time: 'bad' },
    { ride_date: '2026-02-30', pickup_time: '08:00', dropoff_time: '09:00' },
  ])('marks unsupported timing unknown: %j', (fields) => {
    const result = assessDriverSchedule([ride({ id: 'a', ...fields })]);
    expect([...result.incompleteTiming]).toEqual(['a']);
    expect(result.conflicts.size).toBe(0);
  });

  it('uses recorded seconds and reports all overlapping pairs regardless of input order', () => {
    const result = assessDriverSchedule([
      ride({ id: 'c', pickup_time: '08:00:45', dropoff_time: '08:01' }),
      ride({ id: 'a', pickup_time: '08:00:00', dropoff_time: '08:00:30' }),
      ride({ id: 'b', pickup_time: '08:00:20', dropoff_time: '08:00:50' }),
    ]);
    expect([...result.conflicts].sort()).toEqual(['a', 'b', 'c']);
  });

  it('does not double-book a duplicated row and does not mutate source rows', () => {
    const a = Object.freeze(ride({ id: 'a', pickup_time: '08:00', dropoff_time: '09:00' }));
    const rows = [a, a];
    expect(driverConflicts(rows).size).toBe(0);
    expect(rows).toEqual([a, a]);
  });
});

describe('needsDriverCount', () => {
  it('counts active rides without a driver', () => {
    expect(needsDriverCount([
      ride({ driver_id: null }),
      ride({ driver_id: null, status: 'cancelled' }),
      ride({ driver_id: null, status: 'completed' }),
      ride({ driver_id: 'd1' }),
    ])).toBe(1);
  });
});

describe('rideWindow', () => {
  it('places the pickup on the family wall clock and ends at the recorded drop-off', () => {
    const w = rideWindow({ ride_date: '2026-09-05', pickup_time: '14:30', dropoff_time: '15:15:00' }, 'America/New_York');
    expect(w).toEqual({ start: Date.parse('2026-09-05T18:30:00Z'), end: Date.parse('2026-09-05T19:15:00Z'), knownEnd: true });
  });

  it('assumes a default duration when the drop-off is missing or not after the pickup', () => {
    const w = rideWindow({ ride_date: '2026-09-05', pickup_time: '14:30', dropoff_time: null }, 'UTC', 45);
    expect(w).toEqual({ start: Date.parse('2026-09-05T14:30:00Z'), end: Date.parse('2026-09-05T15:15:00Z'), knownEnd: false });
    const backwards = rideWindow({ ride_date: '2026-09-05', pickup_time: '14:30', dropoff_time: '14:00' }, 'UTC');
    expect(backwards).toEqual({ start: Date.parse('2026-09-05T14:30:00Z'), end: Date.parse('2026-09-05T15:30:00Z'), knownEnd: false });
  });

  it('returns null for a ride that cannot be placed', () => {
    expect(rideWindow({ ride_date: '2026-09-05', pickup_time: null, dropoff_time: null }, 'UTC')).toBeNull();
    expect(rideWindow({ ride_date: 'someday', pickup_time: '14:30', dropoff_time: null }, 'UTC')).toBeNull();
  });
});
