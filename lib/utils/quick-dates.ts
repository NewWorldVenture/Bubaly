// Shared helpers for native date / datetime-local inputs and the one-tap
// relative-time presets used across reminders, chores, and other scheduling
// forms. Kept separate from format.ts (which is display-only) because these
// produce the exact local-time strings the HTML inputs expect.

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Format a Date as the `YYYY-MM-DD` string a `<input type="date">` expects (local time). */
export function toLocalDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Format a Date as the `YYYY-MM-DDTHH:mm` string a `<input type="datetime-local">` expects (local time). */
export function toLocalDateTimeInput(d: Date): string {
  return `${toLocalDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export type QuickWhen = { label: string; compute: () => Date };

/** Days until the next given weekday (0=Sun..6=Sat), always in the future (never today). */
function daysUntilWeekday(target: number): number {
  const today = new Date().getDay();
  return (target - today + 7) % 7 || 7;
}

/** One-tap due-date presets (date only) — Today / Tomorrow / This weekend / Next week. */
export const QUICK_DATE_PRESETS: QuickWhen[] = [
  { label: 'Today', compute: () => new Date() },
  { label: 'Tomorrow', compute: () => { const d = new Date(); d.setDate(d.getDate() + 1); return d; } },
  { label: 'This weekend', compute: () => { const d = new Date(); d.setDate(d.getDate() + daysUntilWeekday(6)); return d; } },
  { label: 'Next week', compute: () => { const d = new Date(); d.setDate(d.getDate() + daysUntilWeekday(1)); return d; } },
];

/** One-tap reminder-time presets (date + time). */
export const QUICK_TIME_PRESETS: QuickWhen[] = [
  { label: 'In 1 hour', compute: () => new Date(Date.now() + 60 * 60 * 1000) },
  { label: 'Tonight 6pm', compute: () => { const d = new Date(); d.setHours(18, 0, 0, 0); if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1); return d; } },
  { label: 'Tomorrow 9am', compute: () => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); return d; } },
  { label: 'This weekend', compute: () => { const d = new Date(); d.setDate(d.getDate() + daysUntilWeekday(6)); d.setHours(10, 0, 0, 0); return d; } },
  { label: 'Next week', compute: () => { const d = new Date(); d.setDate(d.getDate() + daysUntilWeekday(1)); d.setHours(9, 0, 0, 0); return d; } },
];
