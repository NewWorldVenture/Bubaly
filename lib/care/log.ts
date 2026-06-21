// lib/care/log.ts — pure helpers for the Caregiver / Elder care log.
//
// No Supabase / React imports so timeline ordering, last-contact, and
// well-being math stay deterministically unit-testable.

export type CareLogType = 'check_in' | 'visit' | 'call' | 'meal' | 'medication' | 'appointment' | 'incident' | 'note';

export interface CareEntryLike {
  id: string;
  occurred_at: string; // ISO timestamp
  wellbeing: number | null;
  log_type: CareLogType;
}

/** Entries newest-first. */
export function sortByRecent<T extends CareEntryLike>(entries: T[]): T[] {
  return [...entries].sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
}

/** The most recent entry, or null. */
export function lastContact<T extends CareEntryLike>(entries: T[]): T | null {
  return sortByRecent(entries)[0] ?? null;
}

/**
 * Whole hours since the most recent entry relative to `now`, or null when there
 * are no entries. Never negative.
 */
export function hoursSinceLastContact(entries: CareEntryLike[], now: Date): number | null {
  const last = lastContact(entries);
  if (!last) return null;
  const diff = now.getTime() - new Date(last.occurred_at).getTime();
  return Math.max(0, Math.floor(diff / (3600 * 1000)));
}

/**
 * True when the last contact is older than `thresholdHours` (or there has never
 * been any contact) — the signal a caregiver dashboard surfaces.
 */
export function isContactOverdue(entries: CareEntryLike[], now: Date, thresholdHours = 24): boolean {
  const hrs = hoursSinceLastContact(entries, now);
  return hrs === null || hrs >= thresholdHours;
}

/** Average well-being (1–5, one decimal) over entries that recorded one, or null. */
export function averageWellbeing(entries: CareEntryLike[]): number | null {
  const rated = entries.filter((e) => e.wellbeing != null) as (CareEntryLike & { wellbeing: number })[];
  if (rated.length === 0) return null;
  const sum = rated.reduce((acc, e) => acc + e.wellbeing, 0);
  return Math.round((sum / rated.length) * 10) / 10;
}

/** Groups entries by local day-key (YYYY-MM-DD), newest day first. */
export function groupByDay<T extends CareEntryLike>(entries: T[]): [string, T[]][] {
  const map = new Map<string, T[]>();
  for (const e of sortByRecent(entries)) {
    const d = new Date(e.occurred_at);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const arr = map.get(key) ?? [];
    arr.push(e);
    map.set(key, arr);
  }
  return [...map.entries()].sort((a, b) => b[0].localeCompare(a[0]));
}

/** Count of entries within the trailing `days` window relative to `now`. */
export function entriesInLastDays(entries: CareEntryLike[], now: Date, days = 7): number {
  const cutoff = now.getTime() - days * 24 * 3600 * 1000;
  return entries.filter((e) => new Date(e.occurred_at).getTime() >= cutoff).length;
}

export const CARE_LOG_TYPE_LABELS: Record<CareLogType, string> = {
  check_in: 'Check-in', visit: 'Visit', call: 'Call', meal: 'Meal',
  medication: 'Medication', appointment: 'Appointment', incident: 'Incident', note: 'Note',
};
