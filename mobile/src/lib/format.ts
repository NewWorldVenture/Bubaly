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
  if (p) return `${p.year.padStart(4, '0')}-${p.month}-${p.day}`;
  const y = String(date.getFullYear()).padStart(4, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function shiftDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

/** Advance a Gregorian family DATE, independently of a day's elapsed length. */
export function nextDayKey(key: string): string {
  return new Date(Date.parse(`${key}T12:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
}

/** Bounded search for the next family date, including skipped midnights/dates. */
export function nextFamilyDayDelay(now: Date, timezone: string): number {
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const keyAt = (instant: number) => {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).map(p => [p.type, p.value]));
    return `${parts.year.padStart(4, '0')}-${parts.month}-${parts.day}`;
  };
  const start = now.getTime();
  const today = keyAt(start);
  let before = start;
  let after = start + 3 * DAY_MS;
  if (keyAt(after) <= today) throw new RangeError('Family date boundary unavailable');
  while (after - before > 1) {
    const middle = before + Math.floor((after - before) / 2);
    if (keyAt(middle) <= today) before = middle;
    else after = middle;
  }
  return Math.max(1, after - start);
}

/** "Today", "Tomorrow", or "Sat, Sep 6". */
export function dayLabel(date: Date, tz: string, now = new Date()): string {
  const key = dayKey(date, tz);
  if (key === dayKey(now, tz)) return 'Today';
  if (key === nextDayKey(dayKey(now, tz))) return 'Tomorrow';
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
  // "Is this today?" is a calendar question, answered against the day KEY.
  // Asking it of dayLabel()'s output instead made the word "Today" load-bearing:
  // once that label is translated, every item due later today starts reading
  // "Overdue", and no test on this side of the seam would have said so.
  const isToday = dayKey(date, tz) === dayKey(now, tz);
  if (date.getTime() < now.getTime() && !isToday) {
    const p = partsFor(date, tz, { month: 'short', day: 'numeric' });
    return `Overdue · ${p ? `${p.month} ${p.day}` : dayKey(date, tz)}`;
  }
  if (isToday) return `Due today · ${formatTime(iso, tz)}`;
  return `Due ${dayLabel(date, tz, now)}`;
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
