// lib/medications/adherence.ts — pure helpers for the Medication Tracker.
//
// Kept free of Supabase / React so dose expansion and adherence math can be
// unit tested deterministically.
//
// A dose slot is a reading on the FAMILY's clock, not on whichever clock
// happens to be running the code. Pass the family's zone and both the browser
// that logs a dose and the reminder cron that reads it back resolve
// "2026-09-13T08:00" to the same instant. Omit it and slots resolve against the
// runtime — right in a browser sitting in the family's zone, and UTC on a
// server, which is how the cron came to read every already-taken dose as
// pending and nag a household for pills it had swallowed.

import { isValidTimezone, zonedLocalToInstant } from '@/lib/time/zoned';

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

/** Resolve the existing browser-local schedule contract without silently
 * moving an invalid date/time (including a missing DST hour) to another slot. */
export function doseSlotInstant(slotKey: string, timezone?: string | null): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(slotKey);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  if (timezone && isValidTimezone(timezone)) {
    // Returns null for the same two cases as the runtime path below: a date
    // that does not exist, and the hour spring-forward skips.
    return zonedLocalToInstant(year, month, day, hour * 60 + minute, timezone)?.toISOString() ?? null;
  }
  const instant = new Date(year, month - 1, day, hour, minute);
  if (instant.getFullYear() !== year || instant.getMonth() !== month - 1 || instant.getDate() !== day
    || instant.getHours() !== hour || instant.getMinutes() !== minute) return null;
  return instant.toISOString();
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
export function dosesForDay(
  schedules: ScheduleLike[], logs: DoseLogLike[], day: Date, timezone?: string | null,
): DueDose[] {
  const dayKey = localDateKey(day);
  const weekday = day.getDay();
  // Match the database's unique (schedule_id, scheduled_for) slot. A schedule
  // whose time changes must not consume or toggle an earlier dose that day.
  const logBySlot = new Map<string, DoseStatus>();
  for (const log of logs) {
    if (!log.schedule_id) continue;
    const instant = new Date(log.scheduled_for).getTime();
    if (Number.isFinite(instant)) logBySlot.set(`${log.schedule_id}@${instant}`, log.status);
  }

  const due: DueDose[] = [];
  for (const s of schedules) {
    if (!scheduleCoversDay(s, dayKey, weekday)) continue;
    const time = shortTime(s.time_of_day);
    const slotKey = `${dayKey}T${time}`;
    const instant = doseSlotInstant(slotKey, timezone);
    // Keep an unresolvable local time visible for review instead of silently
    // dropping a scheduled dose or assigning it to a different clock time.
    const status = instant ? logBySlot.get(`${s.id}@${new Date(instant).getTime()}`) ?? 'pending' : 'pending';
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
