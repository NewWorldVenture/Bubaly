// lib/autopilot/reminder-time.ts — when an Autopilot reminder may actually fire.
//
// The reminder notifier only selects rows whose `remind_at` is still ahead of
// it (lib/server/notifications.ts: `remind_at >= now`). A reminder written with
// an instant that has already passed — 09:00 today for a family whose 09:00 was
// hours ago, an overdue refill's morning, a renewal "due today" accepted in the
// afternoon — is stored, stamped "handled", and never delivered.
//
// Pure, so the scan, the accept path and the tests share one answer.
import { dayKeyInZone, zonedTimeMs } from '@/lib/schedule/zoned';

/** A reminder must be at least this far ahead of now to count as still to come. */
export const REMINDER_LEAD_MS = 5 * 60_000;

function addDays(dayKey: string, days: number): string {
  const ms = Date.parse(`${dayKey}T00:00:00Z`);
  return new Date(ms + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * `at` when it is still ahead of `now`; otherwise the family's next 09:00 that
 * is. Never returns an instant in the past.
 *
 * Only for a reminder about a DAY (see `reminderIsoFor`): applied to an event's
 * time it turns a missed "leave by" into a wrong reminder tomorrow morning.
 */
export function deliverableReminderIso(at: string | null | undefined, now: Date, tz: string): string {
  const nowMs = now.getTime();
  const atMs = typeof at === 'string' ? Date.parse(at) : Number.NaN;
  if (typeof at === 'string' && Number.isFinite(atMs) && atMs > nowMs + REMINDER_LEAD_MS) return at;
  const today = dayKeyInZone(nowMs, tz) ?? new Date(nowMs).toISOString().slice(0, 10);
  for (let i = 0; i <= 2; i++) {
    const ms = zonedTimeMs(addDays(today, i), 9, 0, tz);
    if (Number.isFinite(ms) && ms > nowMs + REMINDER_LEAD_MS) return new Date(ms).toISOString();
  }
  return new Date(nowMs + REMINDER_LEAD_MS * 2).toISOString();
}

/**
 * Sources whose reminder is about an INSTANT: an appointment's start, a
 * calendar event's start, a moment's "leave by". Everything else — the
 * renewal, the insurance renewal, the medication refill, and a legacy card
 * with no source recorded — is about a DAY: missing its morning, the reminder
 * is still worth having at the next one (the passport still lapses on the 23rd).
 */
const EVENT_TIED_SOURCES = new Set(['appointments', 'calendar_events']);

/** Whether a reminder for `sourceKind` may move to a later morning once its own time has passed. */
export function isDayTiedSource(sourceKind: string | null | undefined): boolean {
  return !sourceKind || !EVENT_TIED_SOURCES.has(sourceKind);
}

/**
 * The instant to write a reminder for, or null when there is none worth
 * writing.
 *
 * Day-tied sources keep the next-09:00 rule above. An event-tied one — an
 * appointment, a calendar event, a moment's "leave by" — is about an INSTANT:
 * "Leave for soccer" at 09:00 tomorrow, for a game that was at 11:00 today, is
 * not a late reminder but a wrong one. Once its time (less the lead the
 * notifier needs) has passed, or the card itself has expired, there is
 * nothing left to remind anyone of.
 */
export function reminderIsoFor(
  sourceKind: string | null | undefined,
  at: string | null | undefined,
  now: Date,
  tz: string,
  expiresAt?: string | null,
): string | null {
  const nowMs = now.getTime();
  if (expiresAt) {
    const expiresMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) return null;
  }
  if (isDayTiedSource(sourceKind)) return deliverableReminderIso(at, now, tz);
  const atMs = typeof at === 'string' ? Date.parse(at) : Number.NaN;
  return typeof at === 'string' && Number.isFinite(atMs) && atMs > nowMs + REMINDER_LEAD_MS ? at : null;
}

/**
 * Whether the scan should drop a draft before it is stored or acted on: its
 * card has expired, or it is an event-tied reminder whose moment has passed.
 */
export function draftHasLapsed(
  draft: { sourceKind: string | null; actionType: string | null; payload: Record<string, unknown>; expiresAt: string | null },
  now: Date,
  tz: string,
): boolean {
  if (draft.expiresAt) {
    const expiresMs = Date.parse(draft.expiresAt);
    if (!Number.isFinite(expiresMs) || expiresMs <= now.getTime()) return true;
  }
  if (draft.actionType !== 'create_reminder' || isDayTiedSource(draft.sourceKind)) return false;
  const at = typeof draft.payload.at === 'string' ? draft.payload.at : null;
  return reminderIsoFor(draft.sourceKind, at, now, tz) === null;
}
