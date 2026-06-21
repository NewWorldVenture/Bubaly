// lib/trips/planner.ts — pure helpers for the Travel / Trip planner.
//
// No Supabase / React imports so countdown, duration, and checklist-progress
// math stay deterministically unit-testable.

export type TripStatus = 'planning' | 'booked' | 'active' | 'completed' | 'cancelled';
export type TripItemKind = 'packing' | 'todo' | 'reservation' | 'document';

export interface TripLike {
  start_date: string | null; // YYYY-MM-DD
  end_date: string | null;
  status: TripStatus;
}

export interface TripItemLike {
  kind: TripItemKind;
  is_done: boolean;
}

const MS_DAY = 24 * 60 * 60 * 1000;

/** Whole-day difference between two YYYY-MM-DD keys (b - a). */
function dayDiff(aKey: string, bKey: string): number {
  const a = Date.UTC(+aKey.slice(0, 4), +aKey.slice(5, 7) - 1, +aKey.slice(8, 10));
  const b = Date.UTC(+bKey.slice(0, 4), +bKey.slice(5, 7) - 1, +bKey.slice(8, 10));
  return Math.round((b - a) / MS_DAY);
}

/** Inclusive trip length in days, or null when dates are missing/invalid. */
export function tripDurationDays(trip: TripLike): number | null {
  if (!trip.start_date || !trip.end_date) return null;
  const d = dayDiff(trip.start_date, trip.end_date);
  return d < 0 ? null : d + 1;
}

/**
 * Days until the trip starts, relative to `todayKey`.
 *  > 0  → upcoming (n days away)
 *  0    → starts today
 *  < 0  → already started/past
 *  null → no start date.
 */
export function daysUntil(trip: TripLike, todayKey: string): number | null {
  if (!trip.start_date) return null;
  return dayDiff(todayKey, trip.start_date);
}

/** A trip is "upcoming" if not cancelled/completed and ends today or later. */
export function isUpcoming(trip: TripLike, todayKey: string): boolean {
  if (trip.status === 'cancelled' || trip.status === 'completed') return false;
  if (!trip.end_date) return true; // undated trips are still being planned
  return dayDiff(todayKey, trip.end_date) >= 0;
}

export interface ChecklistProgress {
  total: number;
  done: number;
  percent: number; // 0–100, 0 when empty
}

/** Overall checklist completion for a trip's items. */
export function checklistProgress(items: TripItemLike[]): ChecklistProgress {
  const total = items.length;
  const done = items.filter((i) => i.is_done).length;
  return { total, done, percent: total === 0 ? 0 : Math.round((done / total) * 100) };
}

/** Per-kind progress, useful for section headers. */
export function progressByKind(items: TripItemLike[]): Record<TripItemKind, ChecklistProgress> {
  const kinds: TripItemKind[] = ['packing', 'todo', 'reservation', 'document'];
  const out = {} as Record<TripItemKind, ChecklistProgress>;
  for (const k of kinds) out[k] = checklistProgress(items.filter((i) => i.kind === k));
  return out;
}

export const TRIP_STATUS_LABELS: Record<TripStatus, string> = {
  planning: 'Planning', booked: 'Booked', active: 'Active', completed: 'Completed', cancelled: 'Cancelled',
};
export const TRIP_ITEM_KIND_LABELS: Record<TripItemKind, string> = {
  packing: 'Packing', todo: 'To-Do', reservation: 'Reservations', document: 'Documents',
};
