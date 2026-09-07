// lib/trips/drive-time.ts — ONE drive-time source for every leave-by the app
// computes. PURE + tested.
//
// Trip Intelligence (app/(app)/dashboard/trip-intel) and Schedule Intelligence
// (lib/schedule/intelligence.ts) both answer "when do we need to head out?".
// If each turned its own numbers into a departure its own way, the calendar
// event card and the Trip Intelligence page would disagree about the same
// drive. So the fetcher contract and the estimate → `computeDeparture` input
// mapping live here, and both callers go through them.
//
// Two fetchers ship:
//   - `departurePlanDriveTime` reads the family's PERSISTED departure plans
//     (`departure_plans`, written by Trip Intelligence). Server-safe, no
//     network, and honest: it only ever reports a drive time somebody actually
//     computed and saved.
//   - `routedDriveTime` wraps live OSRM routing for the browser, where the
//     public router is reachable (see lib/trips/routing.ts on why the network
//     call runs client-side).

import { computeDeparture, type DepartureInput, type DeparturePlan } from '@/lib/trips/departure';
import { driveEstimate, type LatLng } from '@/lib/trips/routing';

/** The moving parts of getting to one event; everything but `driveSeconds` is optional. */
export type DriveTimeEstimate = {
  /** Real driving time in seconds. */
  driveSeconds: number;
  /** Minutes to get ready before walking out. Only moves `getReadyBy`, never `leaveBy`. */
  prepMinutes?: number;
  /** Minutes to park and walk in at the destination. */
  parkMinutes?: number;
  /** Arrive-early cushion. */
  bufferMinutes?: number;
  /** Live-traffic multiplier on the drive (1 = free-flow). */
  trafficFactor?: number;
  /** Extra minutes of weather penalty. */
  weatherDelayMinutes?: number;
  /** Where the number came from, for the UI to say so. */
  source: 'departure_plan' | 'routed' | 'manual';
};

export type DriveTimeRequest = {
  eventId: string;
  title: string;
  location: string;
  /** ISO instant the event starts. */
  startsAt: string;
};

/**
 * Resolves a drive-time estimate for one event, or null when nothing is known.
 * A fetcher must never throw for "unknown": null is the answer that makes the
 * caller fall back to the category buffer.
 */
export type DriveTimeFetcher = (req: DriveTimeRequest) => Promise<DriveTimeEstimate | null>;

export const DEFAULT_PREP_MINUTES = 15;
export const DEFAULT_PARK_MINUTES = 5;
export const DEFAULT_BUFFER_MINUTES = 5;

/**
 * The one mapping from an estimate to `computeDeparture`'s input. Missing
 * pieces take the same defaults everywhere, so a Trip Intelligence plan and a
 * calendar card fed the same drive seconds land on the same leave-by minute.
 */
export function departureInputFromEstimate(est: DriveTimeEstimate, eventStartISO: string, now: Date): DepartureInput {
  return {
    eventStartISO,
    driveSeconds: Math.max(0, est.driveSeconds),
    prepMinutes: est.prepMinutes ?? DEFAULT_PREP_MINUTES,
    parkMinutes: est.parkMinutes ?? DEFAULT_PARK_MINUTES,
    bufferMinutes: est.bufferMinutes ?? DEFAULT_BUFFER_MINUTES,
    trafficFactor: est.trafficFactor ?? 1,
    weatherDelayMinutes: est.weatherDelayMinutes ?? 0,
    now,
  };
}

/** `computeDeparture` through the shared mapping — the only way callers should reach it for an estimate. */
export function departureFromEstimate(est: DriveTimeEstimate, eventStartISO: string, now: Date): DeparturePlan {
  return computeDeparture(departureInputFromEstimate(est, eventStartISO, now));
}

/** The columns of `departure_plans` a fetcher needs; a partial row is enough. */
export type DeparturePlanLike = {
  event_id: string | null;
  drive_seconds: number;
  traffic_factor?: number | null;
  weather_delay_minutes?: number | null;
  prep_minutes?: number | null;
  park_minutes?: number | null;
  buffer_minutes?: number | null;
  /** Newest plan wins when an event has several. */
  updated_at?: string | null;
};

/**
 * A fetcher over persisted departure plans, keyed by the event they were saved
 * for. Nothing is invented: an event without a saved plan answers null and the
 * caller falls back to the category buffer.
 */
export function departurePlanDriveTime(plans: DeparturePlanLike[]): DriveTimeFetcher {
  const byEvent = new Map<string, DeparturePlanLike>();
  for (const p of plans ?? []) {
    if (!p.event_id || !Number.isFinite(p.drive_seconds)) continue;
    const prev = byEvent.get(p.event_id);
    if (!prev || Date.parse(p.updated_at ?? '') > Date.parse(prev.updated_at ?? '')) byEvent.set(p.event_id, p);
  }
  return async (req) => {
    const p = byEvent.get(req.eventId);
    if (!p) return null;
    return {
      driveSeconds: p.drive_seconds,
      trafficFactor: p.traffic_factor ?? undefined,
      weatherDelayMinutes: p.weather_delay_minutes ?? undefined,
      prepMinutes: p.prep_minutes ?? undefined,
      parkMinutes: p.park_minutes ?? undefined,
      bufferMinutes: p.buffer_minutes ?? undefined,
      source: 'departure_plan',
    };
  };
}

/**
 * Try each fetcher in order; the first non-null estimate wins. A fetcher that
 * throws is treated as "unknown" so one flaky source cannot take the whole
 * schedule down — the fallback buffer is always available.
 */
export function firstDriveTime(...fetchers: (DriveTimeFetcher | null | undefined)[]): DriveTimeFetcher {
  const list = fetchers.filter((f): f is DriveTimeFetcher => typeof f === 'function');
  return async (req) => {
    for (const f of list) {
      try {
        const est = await f(req);
        if (est && Number.isFinite(est.driveSeconds)) return est;
      } catch {
        // unknown — try the next source
      }
    }
    return null;
  };
}

/**
 * Live routing for the browser: the caller supplies the family's origin and a
 * way to turn an event's location into coordinates (geocoding is its own
 * network call and belongs to the caller's UI state).
 */
export function routedDriveTime(opts: {
  origin: LatLng;
  locate: (location: string) => Promise<LatLng | null>;
  estimate?: (from: LatLng, to: LatLng) => Promise<{ seconds: number } | null>;
}): DriveTimeFetcher {
  const estimate = opts.estimate ?? driveEstimate;
  return async (req) => {
    const dest = await opts.locate(req.location);
    if (!dest) return null;
    const est = await estimate(opts.origin, dest);
    if (!est) return null;
    return { driveSeconds: est.seconds, source: 'routed' };
  };
}
