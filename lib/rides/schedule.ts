// lib/rides/schedule.ts — pure helpers for the Transportation / Carpool planner.
//
// No Supabase / React imports so grouping and conflict detection stay
// deterministically unit-testable.

export type RideStatus = 'planned' | 'confirmed' | 'completed' | 'cancelled';

export interface RideLike {
  id: string;
  title: string;
  ride_date: string;            // YYYY-MM-DD
  pickup_time: string | null;   // "HH:MM[:SS]"
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

/**
 * Detects driver double-bookings: a driver assigned to two non-cancelled rides
 * at the same date + pickup time. Returns the set of conflicting ride ids so the
 * UI can flag them.
 */
export function driverConflicts(rides: RideLike[]): Set<string> {
  const seen = new Map<string, string[]>(); // key -> ride ids
  for (const r of rides) {
    if (r.status === 'cancelled' || !r.driver_id || !r.pickup_time) continue;
    const key = `${r.driver_id}@${r.ride_date}T${shortTime(r.pickup_time)}`;
    const arr = seen.get(key) ?? [];
    arr.push(r.id);
    seen.set(key, arr);
  }
  const conflicting = new Set<string>();
  for (const ids of seen.values()) {
    if (ids.length > 1) ids.forEach((id) => conflicting.add(id));
  }
  return conflicting;
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
