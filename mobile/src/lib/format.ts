// Date/time formatting in the FAMILY's time zone (not the device's), so a
// parent travelling still sees "Soccer · 4:00 PM" the way the household does.
// Pure — unit-tested from the repo root.

const DAY_MS = 86_400_000;

function partsFor(date: Date, tz: string, options: Intl.DateTimeFormatOptions): Record<string, string> | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, ...options }).formatToParts(date);
    return Object.fromEntries(parts.map((p) => [p.type, p.value]));
  } catch {
    return null;
  }
}

/** `YYYY-MM-DD` for the given instant in `tz` (device-local fallback). */
export function dayKey(date: Date, tz: string): string {
  const p = partsFor(date, tz, { year: 'numeric', month: '2-digit', day: '2-digit' });
  if (p) return `${p.year}-${p.month}-${p.day}`;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function shiftDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

/** "Today", "Tomorrow", or "Sat, Sep 6". */
export function dayLabel(date: Date, tz: string, now = new Date()): string {
  const key = dayKey(date, tz);
  if (key === dayKey(now, tz)) return 'Today';
  if (key === dayKey(shiftDays(now, 1), tz)) return 'Tomorrow';
  const p = partsFor(date, tz, { weekday: 'short', month: 'short', day: 'numeric' });
  return p ? `${p.weekday}, ${p.month} ${p.day}` : key;
}

/** "3:00 PM" (or "All day"). */
export function formatTime(iso: string, tz: string, allDay = false): string {
  if (allDay) return 'All day';
  const p = partsFor(new Date(iso), tz, { hour: 'numeric', minute: '2-digit' });
  return p ? `${p.hour}:${p.minute} ${p.dayPeriod ?? ''}`.trim() : iso.slice(11, 16);
}

export type DayGroup<T> = { key: string; label: string; items: T[] };

/** Group items by their day in `tz`, preserving the input order inside a day. */
export function groupByDay<T>(items: T[], getIso: (item: T) => string, tz: string, now = new Date()): DayGroup<T>[] {
  const groups = new Map<string, DayGroup<T>>();
  for (const item of items) {
    const date = new Date(getIso(item));
    const key = dayKey(date, tz);
    let group = groups.get(key);
    if (!group) {
      group = { key, label: dayLabel(date, tz, now), items: [] };
      groups.set(key, group);
    }
    group.items.push(item);
  }
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** "No due date" · "Overdue · Sep 3" · "Due today · 5:00 PM" · "Due Sat, Sep 6". */
export function dueLabel(iso: string | null | undefined, tz: string, now = new Date()): string {
  if (!iso) return 'No due date';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'No due date';
  const label = dayLabel(date, tz, now);
  if (date.getTime() < now.getTime() && label !== 'Today') {
    const p = partsFor(date, tz, { month: 'short', day: 'numeric' });
    return `Overdue · ${p ? `${p.month} ${p.day}` : dayKey(date, tz)}`;
  }
  if (label === 'Today') return `Due today · ${formatTime(iso, tz)}`;
  return `Due ${label}`;
}

/** Hour-of-day (in `tz`) → greeting. */
export function greeting(now = new Date(), tz = 'UTC'): string {
  const p = partsFor(now, tz, { hour: 'numeric', hour12: false });
  const hour = p ? Number(p.hour) % 24 : now.getHours();
  if (hour < 5) return 'Good night';
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}
