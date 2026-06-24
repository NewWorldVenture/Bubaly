import { describe, expect, it } from 'vitest';
import {
  analyzeRides,
  buildRidesPrompt,
  parseRidesResponse,
  type RideEntryLike,
} from '@/lib/rides/rides-ai';

function ride(overrides: Partial<RideEntryLike> = {}): RideEntryLike {
  return {
    title: 'Soccer practice', ride_date: '2099-01-15', pickup_time: '08:00',
    dropoff_time: '09:00', pickup_location: 'Home', dropoff_location: 'Field',
    driver_id: 'driver1', status: 'planned', ...overrides,
  };
}

describe('analyzeRides', () => {
  it('summarizes rides', () => {
    const r = analyzeRides([
      ride({ status: 'planned' }),
      ride({ status: 'completed' }),
      ride({ status: 'planned', driver_id: null }),
    ]);
    expect(r.totalRides).toBe(3);
    expect(r.completedCount).toBe(1);
    expect(r.needsDriverCount).toBe(1);
    expect(r.summary).toContain('3 rides');
  });

  it('counts upcoming rides', () => {
    const r = analyzeRides([
      ride({ ride_date: '2099-12-31', status: 'planned' }),
      ride({ ride_date: '2000-01-01', status: 'planned' }),
    ]);
    expect(r.upcomingCount).toBe(1);
  });

  it('handles empty list', () => {
    const r = analyzeRides([]);
    expect(r.totalRides).toBe(0);
    expect(r.summary).toContain('0 rides');
  });

  it('excludes cancelled rides from needs-driver count', () => {
    const r = analyzeRides([ride({ driver_id: null, status: 'cancelled' })]);
    expect(r.needsDriverCount).toBe(0);
  });
});

describe('buildRidesPrompt', () => {
  it('builds prompt with ride info', () => {
    const { system, user } = buildRidesPrompt([ride({ title: 'School run', driver_id: null })]);
    expect(system).toContain('JSON');
    expect(user).toContain('School run');
    expect(user).toContain('NO DRIVER');
  });
});

describe('parseRidesResponse', () => {
  it('parses valid JSON', () => {
    const r = parseRidesResponse('{"suggestions":["combine trips"],"carpoolIdeas":["share with neighbors"],"scheduleTip":"plan ahead"}');
    expect(r.suggestions).toEqual(['combine trips']);
    expect(r.carpoolIdeas).toEqual(['share with neighbors']);
    expect(r.scheduleTip).toBe('plan ahead');
  });

  it('handles malformed input', () => {
    const r = parseRidesResponse('nope');
    expect(r.suggestions).toEqual([]);
  });

  it('handles code fences', () => {
    const r = parseRidesResponse('```json\n{"suggestions":["x"],"carpoolIdeas":["y"],"scheduleTip":"z"}\n```');
    expect(r.suggestions).toEqual(['x']);
  });
});
