import { describe, it, expect } from 'vitest';
import { drivingScore, scoreBand, averageScore, splitPlayDates } from '@/lib/family/safety';

describe('drivingScore', () => {
  it('perfect trip scores 100', () => {
    expect(drivingScore({ distance_miles: 10, max_mph: 65, hard_brakes: 0, rapid_accels: 0, phone_use_seconds: 0 })).toBe(100);
  });
  it('deducts for risky events and speeding, clamped to 0..100', () => {
    expect(drivingScore({ distance_miles: 20, max_mph: 85, hard_brakes: 3, rapid_accels: 2, phone_use_seconds: 60 }))
      .toBe(100 - 12 - 6 - 4 - 15); // 63
    expect(drivingScore({ distance_miles: 5, max_mph: 120, hard_brakes: 30, rapid_accels: 30, phone_use_seconds: 600 })).toBe(0);
  });
});

describe('scoreBand', () => {
  it('bands by threshold', () => {
    expect(scoreBand(95)).toBe('excellent');
    expect(scoreBand(80)).toBe('good');
    expect(scoreBand(60)).toBe('fair');
    expect(scoreBand(40)).toBe('poor');
  });
});

describe('averageScore', () => {
  it('averages or returns null', () => {
    expect(averageScore([100, 80, 60])).toBe(80);
    expect(averageScore([])).toBeNull();
  });
});

describe('splitPlayDates', () => {
  it('separates upcoming (future, active) from past', () => {
    const now = new Date('2025-06-01T12:00:00Z');
    const rows = [
      { starts_at: '2025-06-05T10:00:00Z', status: 'planned' },
      { starts_at: '2025-05-20T10:00:00Z', status: 'completed' },
      { starts_at: '2025-06-10T10:00:00Z', status: 'cancelled' }, // future but cancelled → past
      { starts_at: '2025-06-03T10:00:00Z', status: 'confirmed' },
    ];
    const { upcoming, past } = splitPlayDates(rows, now);
    expect(upcoming.map((r) => r.starts_at)).toEqual(['2025-06-03T10:00:00Z', '2025-06-05T10:00:00Z']);
    expect(past).toHaveLength(2);
  });
});
