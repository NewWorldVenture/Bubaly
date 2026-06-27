import { describe, it, expect } from 'vitest';
import {
  computeDeparture, trafficFactorForTime, weatherDelayMinutes,
  leaveByLabel, departureStatusCopy,
} from '@/lib/trips/departure';

describe('trafficFactorForTime', () => {
  it('flags weekday evening rush as the heaviest', () => {
    // Friday 5pm (2026-06-26 is a Friday)
    const f = trafficFactorForTime('2026-06-26T17:00:00', 5, 17);
    expect(f).toBeGreaterThan(1.4);
  });
  it('flags weekday morning rush', () => {
    expect(trafficFactorForTime('2026-06-26T08:00:00', 5, 8)).toBeCloseTo(1.45);
  });
  it('is free-flow overnight', () => {
    expect(trafficFactorForTime('2026-06-26T02:00:00', 5, 2)).toBe(1);
  });
  it('is lighter on weekends', () => {
    const sat = trafficFactorForTime('2026-06-27T17:00:00', 6, 17);
    const weekday = trafficFactorForTime('2026-06-26T17:00:00', 5, 17);
    expect(sat).toBeLessThan(weekday);
  });
  it('returns 1 for invalid input', () => {
    expect(trafficFactorForTime('not-a-date')).toBe(1);
  });
});

describe('weatherDelayMinutes', () => {
  it('adds nothing for clear skies', () => {
    expect(weatherDelayMinutes(0)).toBe(0);
    expect(weatherDelayMinutes(null)).toBe(0);
  });
  it('penalizes heavy snow the most', () => {
    expect(weatherDelayMinutes(75)).toBeGreaterThan(weatherDelayMinutes(61));
  });
  it('adds a bump for high precipitation probability', () => {
    expect(weatherDelayMinutes(61, 90)).toBeGreaterThan(weatherDelayMinutes(61, 10));
  });
});

describe('computeDeparture', () => {
  const base = {
    eventStartISO: '2026-06-26T19:00:00.000Z',
    driveSeconds: 1200, // 20 min free-flow
    prepMinutes: 30,
    parkMinutes: 10,
    now: '2026-06-26T17:00:00.000Z',
  };

  it('works backward from the event time', () => {
    const plan = computeDeparture({ ...base, trafficFactor: 1, bufferMinutes: 5, weatherDelayMinutes: 0 });
    // arrive_by = 18:55. leave_by = 18:55 − 10 park − 20 drive = 18:25.
    expect(plan.leaveByISO).toBe('2026-06-26T18:25:00.000Z');
    // ready_by = 18:25 − 30 prep = 17:55.
    expect(plan.getReadyByISO).toBe('2026-06-26T17:55:00.000Z');
    expect(plan.driveMinutesAdjusted).toBe(20);
    expect(plan.totalTravelMinutes).toBe(35); // 20 + 10 + 0 + 5
  });

  it('applies the traffic multiplier to drive time', () => {
    const plan = computeDeparture({ ...base, trafficFactor: 1.5, bufferMinutes: 5 });
    expect(plan.driveMinutesAdjusted).toBe(30); // 20 × 1.5
    // leave_by = 18:55 − 10 − 30 = 18:15
    expect(plan.leaveByISO).toBe('2026-06-26T18:15:00.000Z');
  });

  it('adds weather delay into the leave-by', () => {
    const noRain = computeDeparture({ ...base, trafficFactor: 1, weatherDelayMinutes: 0, bufferMinutes: 0 });
    const rain = computeDeparture({ ...base, trafficFactor: 1, weatherDelayMinutes: 12, bufferMinutes: 0 });
    const delta = (new Date(noRain.leaveByISO).getTime() - new Date(rain.leaveByISO).getTime()) / 60000;
    expect(delta).toBe(12); // rain means leave 12 min earlier
  });

  it('clamps an absurd traffic factor', () => {
    const plan = computeDeparture({ ...base, trafficFactor: 99 });
    expect(plan.driveMinutesAdjusted).toBe(60); // 20 × 3 (clamped)
  });

  it('reports status by minutes-until-leave', () => {
    const plenty = computeDeparture({ ...base, trafficFactor: 1, now: '2026-06-26T10:00:00.000Z' });
    expect(plenty.status).toBe('plenty');
    const soon = computeDeparture({ ...base, trafficFactor: 1, now: '2026-06-26T18:05:00.000Z' });
    expect(soon.status).toBe('soon');
    const go = computeDeparture({ ...base, trafficFactor: 1, now: '2026-06-26T18:23:00.000Z' });
    expect(go.status).toBe('now');
    const late = computeDeparture({ ...base, trafficFactor: 1, now: '2026-06-26T18:30:00.000Z' });
    expect(late.status).toBe('overdue');
  });
});

describe('labels', () => {
  it('formats leave-by label', () => {
    expect(leaveByLabel(0)).toBe('Leave now');
    expect(leaveByLabel(25)).toBe('Leave in 25 min');
    expect(leaveByLabel(90)).toBe('Leave in 1h 30m');
    expect(leaveByLabel(-5)).toBe('5 min ago');
  });
  it('exposes status copy + tone', () => {
    expect(departureStatusCopy('now').tone).toBe('urgent');
    expect(departureStatusCopy('plenty').tone).toBe('ok');
  });
});
