// lib/rides/schedule.ts — pure helpers for the Transportation / Carpool planner.
//
// No Supabase / React imports so grouping and conflict detection stay
// deterministically unit-testable.

import { zonedTimeMs } from '@/lib/schedule/zoned';

export type RideStatus = 'planned' | 'confirmed' | 'completed' | 'cancelled';

export interface RideLike {
  id: string;
  title: string;
  ride_date: string;            // YYYY-MM-DD
  pickup_time: string | null;   // "HH:MM[:SS]"
  dropoff_time?: string | null;
  driver_id: string | null;
  rider_ids: string[];
  status: RideStatus;
}

/** "HH:MM:SS"|"HH:MM" → "HH:MM"; null/empty passes through as ''. */
export function shortTime(t: string | null | undefined): string {
  if (!t) return '';
  const [h = '00', m = '00'] = t.split(':');
  return `${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
}

/** Sorts rides by date then pickup time (rides without a time sort last in a day). */
export function sortRides<T extends RideLike>(rides: T[]): T[] {
  return [...rides].sort((a, b) => {
    if (a.ride_date !== b.ride_date) return a.ride_date.localeCompare(b.ride_date);
    const at = a.pickup_time ? shortTime(a.pickup_time) : '99:99';
    const bt = b.pickup_time ? shortTime(b.pickup_time) : '99:99';
    return at.localeCompare(bt);
  });
}

/** Groups rides by their date, returning ordered [date, rides] pairs. */
export function groupByDate<T extends RideLike>(rides: T[]): [string, T[]][] {
  const map = new Map<string, T[]>();
  for (const r of sortRides(rides)) {
    const arr = map.get(r.ride_date) ?? [];
    arr.push(r);
    map.set(r.ride_date, arr);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

export interface DriverScheduleAssessment {
  conflicts: Set<string>;
  incompleteTiming: Set<string>;
}

function clockSeconds(value: string | null | undefined): number | null {
  const match = value?.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] ?? 0);
  return hour < 24 && minute < 60 && second < 60
    ? hour * 3600 + minute * 60 + second : null;
}

/**
 * Compare recorded same-day pickup/drop-off windows, without inventing duration
 * or travel time. Missing, invalid and overnight timing remains unknown.
 * A known window can establish a clash with another pickup even if that second
 * ride's drop-off is unknown. Touching windows do not prove travel feasibility.
 */
export function assessDriverSchedule(rides: RideLike[]): DriverScheduleAssessment {
  const conflicts = new Set<string>();
  const incompleteTiming = new Set<string>();
  const seenIds = new Set<string>();
  const groups = new Map<string, { id: string; start: number; end: number | null }[]>();
  for (const r of rides) {
    if (r.status === 'cancelled' || r.status === 'completed' || !r.driver_id || seenIds.has(r.id)) continue;
    seenIds.add(r.id);
    const date = Date.parse(`${r.ride_date}T00:00:00Z`);
    const validDate = /^\d{4}-\d{2}-\d{2}$/.test(r.ride_date)
      && Number.isFinite(date) && new Date(date).toISOString().slice(0, 10) === r.ride_date;
    const start = clockSeconds(r.pickup_time);
    const dropoff = clockSeconds(r.dropoff_time);
    if (!validDate || start === null) {
      incompleteTiming.add(r.id);
      continue;
    }
    const end = dropoff !== null && dropoff > start ? dropoff : null;
    if (end === null) incompleteTiming.add(r.id);
    const key = `${r.driver_id}@${r.ride_date}`;
    const group = groups.get(key) ?? [];
    group.push({ id: r.id, start, end });
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => a.start - b.start);
    for (let i = 0; i < group.length; i += 1) {
      const earlier = group[i];
      for (let j = i + 1; j < group.length; j += 1) {
        const later = group[j];
        if (earlier.end !== null && later.start >= earlier.end) break;
        if (earlier.start === later.start || (earlier.end !== null && later.start < earlier.end)) {
          conflicts.add(earlier.id);
          conflicts.add(later.id);
        }
      }
    }
  }
  return { conflicts, incompleteTiming };
}

/** Compatibility wrapper for callers that only need known conflicting IDs. */
export function driverConflicts(rides: RideLike[]): Set<string> {
  return assessDriverSchedule(rides).conflicts;
}

export type RideWindow = { start: number; end: number; /** false when the drop-off had to be assumed */ knownEnd: boolean };

/**
 * A ride's busy window as epoch ms, resolved on the family's wall clock so it
 * can be compared with calendar instants. `ride_date` + `pickup_time` are the
 * family's local wall clock (the planner stores what the form typed); the
 * drop-off ends the window when it is recorded and later than the pickup,
 * otherwise `defaultDurationMin` is assumed and `knownEnd` says so. Null when
 * the pickup time or date is missing/invalid — a ride with no time cannot be
 * placed against anything.
 */
export function rideWindow(ride: Pick<RideLike, 'ride_date' | 'pickup_time' | 'dropoff_time'>, tz: string, defaultDurationMin = 60): RideWindow | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ride.ride_date)) return null;
  const pickup = clockSeconds(ride.pickup_time);
  if (pickup === null) return null;
  const start = zonedTimeMs(ride.ride_date, Math.floor(pickup / 3600), Math.floor((pickup % 3600) / 60), tz);
  if (!Number.isFinite(start)) return null;
  const dropoff = clockSeconds(ride.dropoff_time);
  if (dropoff !== null && dropoff > pickup) {
    return { start, end: start + (dropoff - pickup) * 1000, knownEnd: true };
  }
  return { start, end: start + Math.max(1, defaultDurationMin) * 60_000, knownEnd: false };
}

/** Rides today or later, excluding completed/cancelled — the "upcoming" view. */
export function upcomingRides<T extends RideLike>(rides: T[], todayKey: string): T[] {
  return sortRides(rides).filter(
    (r) => r.ride_date >= todayKey && r.status !== 'completed' && r.status !== 'cancelled',
  );
}

/** Count of rides still needing a driver assigned (and not cancelled). */
export function needsDriverCount(rides: RideLike[]): number {
  return rides.filter((r) => !r.driver_id && r.status !== 'cancelled' && r.status !== 'completed').length;
}

export const RIDE_STATUS_LABELS: Record<RideStatus, string> = {
  planned: 'Planned',
  confirmed: 'Confirmed',
  completed: 'Completed',
  cancelled: 'Cancelled',
};
