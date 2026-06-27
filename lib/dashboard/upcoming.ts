// lib/dashboard/upcoming.ts — pure helper to merge calendar events and timed
// reminders into a single chronological "Coming Up" feed. DOM-free + testable.

export type UpcomingEventRow = { id: string; title: string; starts_at: string; all_day: boolean };
export type UpcomingReminderRow = { id: string; title: string; remind_at: string | null };

export type UpcomingItem = {
  key: string;
  kind: 'event' | 'reminder';
  id: string;
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
  const items: UpcomingItem[] = [];

  for (const e of events) {
    const t = new Date(e.starts_at).getTime();
    if (Number.isNaN(t)) continue;
    items.push({ key: `event:${e.id}`, kind: 'event', id: e.id, title: e.title, at: e.starts_at, allDay: e.all_day });
  }
  for (const r of reminders) {
    if (!r.remind_at) continue;
    const t = new Date(r.remind_at).getTime();
    if (Number.isNaN(t)) continue;
    items.push({ key: `reminder:${r.id}`, kind: 'reminder', id: r.id, title: r.title, at: r.remind_at, allDay: false });
  }

  items.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  return items.slice(0, Math.max(0, limit));
}
