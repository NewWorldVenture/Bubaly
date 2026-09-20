const DAY_MS = 86_400_000;

function calendarDate(dayKey: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) return null;
  const date = new Date(`${dayKey}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === dayKey ? date : null;
}

/** A date-only value is a calendar day, never a browser-local instant. */
export function mealWeekDays(start: string): string[] {
  const base = calendarDate(start);
  if (!base) return [];
  return Array.from({ length: 7 }, (_, index) => new Date(base.getTime() + index * DAY_MS).toISOString().slice(0, 10));
}

/** Monday through Sunday in the household's timezone, including across DST. */
export function mealWeek(timezone: string, offset: number, now = new Date()): { start: string; days: string[]; today: string } {
  const options: Intl.DateTimeFormatOptions = { timeZone: timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' };
  let formatter: Intl.DateTimeFormat;
  try { formatter = new Intl.DateTimeFormat('en-US', options); }
  catch { formatter = new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' }); }
  const parts = formatter.formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((value) => value.type === type)!.value;
  const today = `${part('year')}-${part('month')}-${part('day')}`;
  const date = calendarDate(today)!;
  const dayOffset = (date.getUTCDay() + 6) % 7;
  const weekOffset = Number.isSafeInteger(offset) ? offset : 0;
  const start = new Date(date.getTime() + (weekOffset * 7 - dayOffset) * DAY_MS).toISOString().slice(0, 10);
  return { start, days: mealWeekDays(start), today };
}

/** Keep the selected date when formatting labels in any browser timezone. */
export function formatMealDay(dayKey: string, locale: string, options: Intl.DateTimeFormatOptions): string {
  const date = calendarDate(dayKey);
  if (!date) return '';
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' }).format(date);
}
