// lib/medications/adherence.ts — pure helpers for the Medication Tracker.
//
// Kept free of Supabase / React so dose expansion and adherence math can be
// unit tested deterministically.

export type DoseStatus = 'taken' | 'skipped' | 'missed';

export interface ScheduleLike {
  id: string;
  medication_id: string;
  time_of_day: string;        // "HH:MM[:SS]"
  days_of_week: number[];     // 0=Sun … 6=Sat
  starts_on: string;          // YYYY-MM-DD
  ends_on: string | null;     // YYYY-MM-DD | null
}

export interface DoseLogLike {
  schedule_id: string | null;
  scheduled_for: string;      // ISO timestamp
  status: DoseStatus;
}

export interface DueDose {
  scheduleId: string;
  medicationId: string;
  /** "HH:MM" for display. */
  time: string;
  /** Canonical slot key — local date + time, e.g. "2026-06-21T08:00". */
  slotKey: string;
  status: DoseStatus | 'pending';
}

/** Normalises a "HH:MM:SS" or "HH:MM" string to "HH:MM". */
export function shortTime(timeOfDay: string): string {
  const [h = '00', m = '00'] = timeOfDay.split(':');
  return `${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
}

/** Local YYYY-MM-DD for a date (not UTC) — doses are reasoned about in the
 *  family's local day. */
export function localDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** True when a schedule is active on the given local day-key and covers that weekday. */
export function scheduleCoversDay(schedule: ScheduleLike, dayKey: string, weekday: number): boolean {
  if (schedule.starts_on && dayKey < schedule.starts_on) return false;
  if (schedule.ends_on && dayKey > schedule.ends_on) return false;
  return schedule.days_of_week.includes(weekday);
}

/**
 * Expands the schedules that are due on `day` into concrete dose slots, joined
 * with any existing log rows so the UI knows which are taken/skipped/pending.
 * Sorted by time of day.
 */
export function dosesForDay(schedules: ScheduleLike[], logs: DoseLogLike[], day: Date): DueDose[] {
  const dayKey = localDateKey(day);
  const weekday = day.getDay();
  // A schedule fires at most once per local day, so (schedule_id + local day of
  // the logged instant) uniquely identifies a dose slot. Matching this way is
  // timezone-robust: a timestamp written from a local day round-trips to the
  // same local day-key in the same browser.
  const logBySlot = new Map<string, DoseStatus>();
  for (const log of logs) {
    if (!log.schedule_id) continue;
    const logDay = localDateKey(new Date(log.scheduled_for));
    logBySlot.set(`${log.schedule_id}@${logDay}`, log.status);
  }

  const due: DueDose[] = [];
  for (const s of schedules) {
    if (!scheduleCoversDay(s, dayKey, weekday)) continue;
    const time = shortTime(s.time_of_day);
    const slotKey = `${dayKey}T${time}`;
    const status = logBySlot.get(`${s.id}@${dayKey}`) ?? 'pending';
    due.push({ scheduleId: s.id, medicationId: s.medication_id, time, slotKey, status });
  }
  return due.sort((a, b) => a.time.localeCompare(b.time));
}

/**
 * Adherence rate (0–100, rounded) over a set of logged doses: taken / (taken +
 * skipped + missed). Returns null when there is nothing logged yet, so callers
 * can show "—" rather than a misleading 0%.
 */
export function adherenceRate(logs: { status: DoseStatus }[]): number | null {
  if (logs.length === 0) return null;
  const taken = logs.filter((l) => l.status === 'taken').length;
  return Math.round((taken / logs.length) * 100);
}

/** Counts of each status, handy for summaries. */
export function doseStatusCounts(logs: { status: DoseStatus }[]): Record<DoseStatus, number> {
  const counts: Record<DoseStatus, number> = { taken: 0, skipped: 0, missed: 0 };
  for (const l of logs) counts[l.status]++;
  return counts;
}

export const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
