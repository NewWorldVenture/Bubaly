// lib/reminders/details.ts — pure helpers for the richer reminder details
// (early reminder, tags, subtasks, URL). DOM-free + fully unit-testable.
import { addWallDays, wallAt, wallDate, wallParts, wallToInstant, type WallParts } from '@/lib/time/wall-clock';
import { isValidTimezone } from '@/lib/time/zoned';

export type Subtask = { id: string; title: string; done: boolean };

/** Lead-time options for an "early reminder" before the due time. */
export const EARLY_REMINDER_OPTIONS: { minutes: number | null; label: string }[] = [
  { minutes: null, label: 'None' },
  { minutes: 0, label: 'At time of event' },
  { minutes: 5, label: '5 minutes before' },
  { minutes: 10, label: '10 minutes before' },
  { minutes: 15, label: '15 minutes before' },
  { minutes: 30, label: '30 minutes before' },
  { minutes: 60, label: '1 hour before' },
  { minutes: 120, label: '2 hours before' },
  { minutes: 1440, label: '1 day before' },
  { minutes: 2880, label: '2 days before' },
  { minutes: 10080, label: '1 week before' },
];

export function earlyReminderLabel(minutes: number | null | undefined): string {
  if (minutes == null) return 'None';
  const found = EARLY_REMINDER_OPTIONS.find((o) => o.minutes === minutes);
  if (found) return found.label;
  if (minutes === 0) return 'At time of event';
  if (minutes % 10080 === 0) return `${minutes / 10080} week${minutes / 10080 > 1 ? 's' : ''} before`;
  if (minutes % 1440 === 0) return `${minutes / 1440} day${minutes / 1440 > 1 ? 's' : ''} before`;
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes / 60 > 1 ? 's' : ''} before`;
  return `${minutes} minute${minutes > 1 ? 's' : ''} before`;
}

/** The instant an early reminder should fire, given the due time. */
export function earlyReminderAt(remindAtIso: string, minutes: number): Date {
  return new Date(new Date(remindAtIso).getTime() - minutes * 60_000);
}

/** Parse a comma-separated tag string into a clean, de-duped list (no leading #). */
export function parseTags(input: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input.split(',')) {
    const t = raw.trim().replace(/^#+/, '').trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

export const formatTags = (tags: string[]): string => tags.join(', ');

function genId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Coerce arbitrary stored JSON into a clean Subtask[]. */
export function normalizeSubtasks(value: unknown): Subtask[] {
  if (!Array.isArray(value)) return [];
  const out: Subtask[] = [];
  for (const v of value) {
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      const title = typeof o.title === 'string' ? o.title.trim() : '';
      if (!title) continue;
      out.push({ id: typeof o.id === 'string' && o.id ? o.id : genId(), title, done: Boolean(o.done) });
    }
  }
  return out;
}

export function newSubtask(title: string): Subtask {
  return { id: genId(), title: title.trim(), done: false };
}

export function subtaskProgress(subtasks: Subtask[]): { done: number; total: number } {
  return { done: subtasks.filter((s) => s.done).length, total: subtasks.length };
}

/**
 * The next occurrence of a recurring reminder after `remindAtIso`, or null for a
 * one-off ('none'). Mirrors the recurrence options: daily, weekdays (next
 * Mon–Fri), weekly, biweekly, monthly, yearly.
 *
 * Pass the FAMILY's `timeZone` wherever there is one. The steps are civil —
 * "the same time tomorrow", "the next weekday" — so they have to be taken on
 * the family's calendar, and without a zone this falls back to the runtime's,
 * which on a server is UTC. There a 'weekdays' reminder at 6pm in Los Angeles
 * (01:00Z the next day) was stepped on UTC's weekdays: Thursday's completion
 * skipped Friday and set Sunday. And a daily 9am kept its UTC instant, so it
 * rang at 8am once the clocks went back. With a zone the wall-clock time is
 * kept across a DST change and the weekday is the family's.
 */
export function nextRemindAt(remindAtIso: string, recurrence: string, timeZone?: string | null): string | null {
  const d = new Date(remindAtIso);
  if (Number.isNaN(d.getTime())) return null;
  if (timeZone && isValidTimezone(timeZone)) return nextOnWallClock(d, recurrence, timeZone);
  switch (recurrence) {
    case 'daily': d.setDate(d.getDate() + 1); break;
    case 'weekdays': {
      do { d.setDate(d.getDate() + 1); } while (d.getDay() === 0 || d.getDay() === 6);
      break;
    }
    case 'weekly': d.setDate(d.getDate() + 7); break;
    case 'biweekly': d.setDate(d.getDate() + 14); break;
    case 'monthly': d.setMonth(d.getMonth() + 1); break;
    case 'yearly': d.setFullYear(d.getFullYear() + 1); break;
    default: return null; // 'none' or unknown
  }
  return d.toISOString();
}

const isWeekend = (p: WallParts) => p.weekday === 0 || p.weekday === 6;

/**
 * `nextRemindAt` stepped on `timeZone`'s calendar: the wall reading is moved
 * (a day, a weekday, a month — overflowing as `setMonth` does, so the two
 * paths agree on a 31st) and the result resolved back to an instant in the
 * same zone. Seconds within the minute are carried over unchanged.
 */
function nextOnWallClock(at: Date, recurrence: string, timeZone: string): string | null {
  const wall = wallAt(at, timeZone);
  const p = wallParts(wall);
  let next: Date;
  switch (recurrence) {
    case 'daily': next = addWallDays(wall, 1); break;
    case 'weekdays': {
      next = addWallDays(wall, 1);
      while (isWeekend(wallParts(next))) next = addWallDays(next, 1);
      break;
    }
    case 'weekly': next = addWallDays(wall, 7); break;
    case 'biweekly': next = addWallDays(wall, 14); break;
    case 'monthly': next = wallDate(p.year, p.month + 1, p.day, p.hour, p.minute); break;
    case 'yearly': next = wallDate(p.year + 1, p.month, p.day, p.hour, p.minute); break;
    default: return null; // 'none' or unknown
  }
  const instant = wallToInstant(next, timeZone);
  if (Number.isNaN(instant.getTime())) return null;
  return new Date(instant.getTime() + at.getUTCSeconds() * 1000 + at.getUTCMilliseconds()).toISOString();
}

/** True for a usable http(s) URL. */
export function isValidHttpUrl(url: string): boolean {
  try {
    const u = new URL(url.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}
