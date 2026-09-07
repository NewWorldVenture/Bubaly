// Which notifications interrupt, and which ones wait for the brief.
//
// WHY THIS IS A FUNCTION AND NOT A COLUMN. `public.notifications`
// (0002_tables.sql:405-418) has `type`, `title`, `body`, `related_type`,
// `related_id`, `is_read`, `send_at`, `sent_at`, `pushed_at` — and nothing that
// says how loud a row should be. Every notice therefore arrives at the same
// volume: the bell counts a sports fixture three days out exactly as it counts
// a medication that is due now.
//
// TODO(migration): add `notifications.priority text not null default 'now'
// check (priority in ('now','digest'))` plus an index on
// `(family_id, priority, is_read, send_at)`, backfill it from
// `notificationPriority(type)`, and let `notify()` accept an explicit
// `priority` so a caller can quieten ONE notice without reclassifying its whole
// type. Until that column exists this classifier is the single place the answer
// lives, so the bell, the list and the brief cannot disagree.
//
// THE CLASSIFICATION IS DELIBERATELY CONSERVATIVE. Folding something into a
// once-a-day summary is a promise that it can wait a day, and getting that
// wrong silences a notice that mattered. So only the types whose whole purpose
// is advance warning are 'digest', and *anything else — including a type added
// after this file was written — is 'now'*. `system` in particular stays 'now':
// it is the catch-all that approval reminders, schedule-conflict notices and
// family reminders all ride on, and burying those would be the exact failure
// this file exists to avoid.
import type { NotificationType } from '@/lib/database.types';

export type NotificationPriority = 'now' | 'digest';

/**
 * The types that can honestly wait for the next brief.
 *
 *  - `school_event` / `sports_event` — the fixture is already on the calendar;
 *    the notice repeats it rather than breaking news.
 *  - `maintenance_task` — "change the filter" has a week of slack in it.
 *  - `grocery_reminder` — a shopping list is read when someone shops.
 *  - `document_expiry` — the deadline builders fire days or weeks ahead
 *    (lib/notifications/deadline-reminders.ts), so the first notice is never
 *    the last chance.
 */
export const DIGEST_NOTIFICATION_TYPES = [
  'school_event',
  'sports_event',
  'maintenance_task',
  'grocery_reminder',
  'document_expiry',
] as const satisfies readonly NotificationType[];

const DIGEST_SET: ReadonlySet<string> = new Set<string>(DIGEST_NOTIFICATION_TYPES);

/** 'digest' only for the documented list above; everything else interrupts. */
export function notificationPriority(type: NotificationType | string | null | undefined): NotificationPriority {
  return typeof type === 'string' && DIGEST_SET.has(type) ? 'digest' : 'now';
}

type PriorityRowLike = { type?: NotificationType | string | null };

/** True when a row belongs in the brief's "Also today" rather than in the bell. */
export function isDigestNotification(row: PriorityRowLike | null | undefined): boolean {
  return notificationPriority(row?.type) === 'digest';
}

/**
 * Split rows into the two audiences, preserving order within each.
 *
 * One pass rather than two filters, because the list renders both halves and a
 * row must land in exactly one of them — never in neither, never in both.
 */
export function partitionByPriority<T extends PriorityRowLike>(rows: readonly T[] | null | undefined): { now: T[]; digest: T[] } {
  const now: T[] = [];
  const digest: T[] = [];
  for (const row of rows ?? []) (isDigestNotification(row) ? digest : now).push(row);
  return { now, digest };
}
