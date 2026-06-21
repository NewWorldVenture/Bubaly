import { describe, it, expect } from 'vitest';
import {
  shortTime, sortRides, groupByDate, driverConflicts, upcomingRides,
  needsDriverCount, type RideLike,
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
