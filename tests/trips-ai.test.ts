import { describe, expect, it } from 'vitest';
import {
  analyzeTrips,
  buildTripsPrompt,
  parseTripsResponse,
  type TripEntryLike,
} from '@/lib/trips/trips-ai';

function trip(overrides: Partial<TripEntryLike>): TripEntryLike {
  return { destination: 'Beach', status: 'planning', start_date: '2026-07-01', end_date: '2026-07-07', checklist_total: 10, checklist_done: 5, ...overrides };
}

describe('analyzeTrips', () => {
  it('summarizes trips', () => {
    const r = analyzeTrips([
      trip({ status: 'planning' }),
      trip({ destination: 'Mountains', status: 'completed', checklist_total: 8, checklist_done: 8 }),
    ]);
    expect(r.totalTrips).toBe(2);
    expect(r.upcomingTrips).toBe(1);
    expect(r.completedTrips).toBe(1);
    expect(r.summary).toContain('2 trips');
    expect(r.summary).toContain('1 upcoming');
  });

  it('calculates checklist completion', () => {
    const r = analyzeTrips([trip({ checklist_total: 10, checklist_done: 7 })]);
    expect(r.avgChecklistCompletion).toBe(70);
  });

  it('handles empty', () => {
    const r = analyzeTrips([]);
    expect(r.totalTrips).toBe(0);
    expect(r.summary).toContain('0 trips');
  });
});

describe('buildTripsPrompt', () => {
  it('builds prompt with trip info', () => {
    const { system, user } = buildTripsPrompt([trip({ destination: 'Paris', status: 'booked' })]);
    expect(system).toContain('JSON');
    expect(user).toContain('Paris');
    expect(user).toContain('booked');
  });
});

describe('parseTripsResponse', () => {
  it('parses valid JSON', () => {
    const r = parseTripsResponse('{"suggestions":["book early"],"packingReminders":["chargers"],"planningTip":"make lists"}');
    expect(r.suggestions).toEqual(['book early']);
    expect(r.packingReminders).toEqual(['chargers']);
    expect(r.planningTip).toBe('make lists');
  });

  it('handles malformed input', () => {
    const r = parseTripsResponse('garbage');
    expect(r.suggestions).toEqual([]);
  });

  it('handles code fences', () => {
    const r = parseTripsResponse('```json\n{"suggestions":["x"],"packingReminders":[],"planningTip":"y"}\n```');
    expect(r.suggestions).toEqual(['x']);
  });
});
