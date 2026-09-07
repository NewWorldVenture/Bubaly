// lib/trips/drive-time — the ONE estimate → departure mapping and the fetcher
// contract that Trip Intelligence and Schedule Intelligence both go through.
// The engine underneath (computeDeparture) keeps its own tests in
// tests/trip-departure.test.ts; this pins that both callers land on the same
// minute and that every fetcher answers null (never throws) for "unknown".
import { describe, expect, it, vi } from 'vitest';
import { computeDeparture } from '@/lib/trips/departure';
import {
  DEFAULT_BUFFER_MINUTES, DEFAULT_PARK_MINUTES, DEFAULT_PREP_MINUTES,
  departureFromEstimate, departureInputFromEstimate, departurePlanDriveTime, firstDriveTime, routedDriveTime,
  type DriveTimeRequest,
} from '@/lib/trips/drive-time';

const NOW = new Date('2026-09-05T14:00:00Z');
const START = '2026-09-05T19:00:00Z';
const req: DriveTimeRequest = { eventId: 'A', title: 'Soccer game', location: 'City Fields', startsAt: START };

describe('departureFromEstimate', () => {
  it('lands on the same minute as computeDeparture given the same numbers — the Trip Intelligence save path and the calendar card agree', () => {
    const viaShared = departureFromEstimate({
      driveSeconds: 1500, prepMinutes: 10, parkMinutes: 8, bufferMinutes: 3, trafficFactor: 1.2, weatherDelayMinutes: 4, source: 'manual',
    }, START, NOW);
    const direct = computeDeparture({
      eventStartISO: START, driveSeconds: 1500, prepMinutes: 10, parkMinutes: 8, bufferMinutes: 3, trafficFactor: 1.2, weatherDelayMinutes: 4, now: NOW,
    });
    expect(viaShared).toEqual(direct);
    expect(viaShared.leaveByISO).toBe('2026-09-05T18:15:00.000Z'); // 15:00 − 3 buffer − 8 park − 4 weather − round(25×1.2)=30 drive
  });

  it('fills the pieces an estimate leaves out with the shared defaults, and never sends a negative drive', () => {
    expect(departureInputFromEstimate({ driveSeconds: 600, source: 'routed' }, START, NOW)).toEqual({
      eventStartISO: START, driveSeconds: 600,
      prepMinutes: DEFAULT_PREP_MINUTES, parkMinutes: DEFAULT_PARK_MINUTES, bufferMinutes: DEFAULT_BUFFER_MINUTES,
      trafficFactor: 1, weatherDelayMinutes: 0, now: NOW,
    });
    expect(departureInputFromEstimate({ driveSeconds: -30, source: 'routed' }, START, NOW).driveSeconds).toBe(0);
  });
});

describe('departurePlanDriveTime', () => {
  it('answers from the newest saved plan for the event, and null for an event nobody planned', async () => {
    const fetcher = departurePlanDriveTime([
      { event_id: 'A', drive_seconds: 900, traffic_factor: 1.1, prep_minutes: 20, updated_at: '2026-09-01T00:00:00Z' },
      { event_id: 'A', drive_seconds: 1200, traffic_factor: 1.3, park_minutes: 7, updated_at: '2026-09-04T00:00:00Z' },
      { event_id: null, drive_seconds: 100 },
      { event_id: 'C', drive_seconds: Number.NaN },
    ]);
    await expect(fetcher(req)).resolves.toEqual({
      driveSeconds: 1200, trafficFactor: 1.3, weatherDelayMinutes: undefined, prepMinutes: undefined, parkMinutes: 7, bufferMinutes: undefined, source: 'departure_plan',
    });
    await expect(fetcher({ ...req, eventId: 'B' })).resolves.toBeNull();
    await expect(fetcher({ ...req, eventId: 'C' })).resolves.toBeNull();
  });
});

describe('firstDriveTime', () => {
  it('takes the first source that answers, treating null and a throw as "unknown"', async () => {
    const quiet = vi.fn(async () => null);
    const broken = vi.fn(async () => { throw new Error('router down'); });
    const answer = vi.fn(async () => ({ driveSeconds: 300, source: 'routed' as const }));
    const never = vi.fn(async () => ({ driveSeconds: 999, source: 'routed' as const }));
    const fetcher = firstDriveTime(quiet, null, undefined, broken, answer, never);
    await expect(fetcher(req)).resolves.toEqual({ driveSeconds: 300, source: 'routed' });
    expect(quiet).toHaveBeenCalledWith(req);
    expect(broken).toHaveBeenCalledWith(req);
    expect(never).not.toHaveBeenCalled();
  });

  it('answers null with no usable source, and skips an estimate without a finite drive', async () => {
    await expect(firstDriveTime()(req)).resolves.toBeNull();
    await expect(firstDriveTime(null, undefined)(req)).resolves.toBeNull();
    const nan = firstDriveTime(async () => ({ driveSeconds: Number.NaN, source: 'routed' }));
    await expect(nan(req)).resolves.toBeNull();
  });
});

describe('routedDriveTime', () => {
  const origin = { lat: 40.7, lng: -74 };

  it('routes from the origin to the located destination', async () => {
    const locate = vi.fn(async () => ({ lat: 40.8, lng: -73.9 }));
    const estimate = vi.fn(async () => ({ seconds: 1234 }));
    const fetcher = routedDriveTime({ origin, locate, estimate });
    await expect(fetcher(req)).resolves.toEqual({ driveSeconds: 1234, source: 'routed' });
    expect(locate).toHaveBeenCalledWith('City Fields');
    expect(estimate).toHaveBeenCalledWith(origin, { lat: 40.8, lng: -73.9 });
  });

  it('answers null when the place cannot be located or the route cannot be estimated', async () => {
    await expect(routedDriveTime({ origin, locate: async () => null, estimate: async () => ({ seconds: 1 }) })(req)).resolves.toBeNull();
    await expect(routedDriveTime({ origin, locate: async () => ({ lat: 1, lng: 1 }), estimate: async () => null })(req)).resolves.toBeNull();
  });
});
