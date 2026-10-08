// lib/dashboard/upcoming.ts — pure helper to merge calendar events and timed
// reminders into a single chronological "Coming Up" feed. DOM-free + testable.

import { calendarConsumerKey, calendarConsumerNativeId, calendarConsumerReference, type CalendarConsumerEvent } from '@/lib/calendar/consumer-spans';
import type { CalendarSnapshotReference } from '@/lib/calendar/source-snapshot';
export type UpcomingEventRow = CalendarConsumerEvent & { displayStartsAt?: string; displayDay?: string };
export type UpcomingReminderRow = { id: string; title: string; remind_at: string | null };

export type UpcomingItem = {
  key: string;
  kind: 'event' | 'reminder';
  id: string | null;
  reference?: CalendarSnapshotReference;
  occurrenceKey?: string;
  title: string;
  at: string;       // ISO timestamp to sort/display by
  allDay: boolean;  // events only; reminders are always false
};

/**
 * Merge calendar events and timed reminders into one list sorted by time
 * ascending. Reminders without a valid timestamp are dropped. The `key` is
 * namespaced by kind so React keys never collide across the two sources.
 */
export function mergeUpcoming(
  events: UpcomingEventRow[],
  reminders: UpcomingReminderRow[],
  limit = 5,
): UpcomingItem[] {
  const items: (UpcomingItem & { sortAt: number })[] = [];

  for (const e of events) {
    const at = e.all_day && e.displayDay ? `${e.displayDay}T00:00:00.000Z` : e.displayStartsAt ?? e.starts_at;
    const t = new Date(at).getTime();
    if (Number.isNaN(t)) continue;
    const id = calendarConsumerNativeId(e);
    items.push({ key: `event:${'occurrenceKey' in e ? calendarConsumerKey(e) : id}`, kind: 'event', id,
      reference: calendarConsumerReference(e), ...('occurrenceKey' in e ? { occurrenceKey: e.occurrenceKey } : {}),
      title: e.title ?? '', at, allDay: !!e.all_day, sortAt: Date.parse(e.displayStartsAt ?? at) });
  }
  for (const r of reminders) {
    if (!r.remind_at) continue;
    const t = new Date(r.remind_at).getTime();
    if (Number.isNaN(t)) continue;
    items.push({ key: `reminder:${r.id}`, kind: 'reminder', id: r.id, title: r.title, at: r.remind_at, allDay: false, sortAt: t });
  }

  items.sort((a, b) => a.sortAt - b.sortAt);
  return items.slice(0, Math.max(0, limit)).map(({ sortAt: _sortAt, ...item }) => item);
}
