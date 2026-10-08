import { dayKey, dayLabel } from './format';

export type CalendarOwner = { userId: string; familyId: string; memberId: string; timezone?: string };
export const calendarOwnerKey = (owner: CalendarOwner | null) => owner ? JSON.stringify([owner.userId, owner.familyId, owner.memberId, owner.timezone]) : '';
export type EventRow = { eventId: string; occurrenceKey: string; title: string; starts_at: string; ends_at: string | null; all_day: boolean; location: string | null; category: string; startDate: string | null; endDate: string | null };
export type CalendarReply = { userId: string; familyId: string; timezone: string; fromDay: string; toDay: string; count: number; occurrences: EventRow[] };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const date = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
const instant = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));
export function parseCalendarReply(body: unknown, owner: CalendarOwner, expectedWindow?: { fromDay: string; days: number }): CalendarReply {
  if (!object(body) || body.userId !== owner.userId || body.familyId !== owner.familyId || typeof body.timezone !== 'string' || !date(body.fromDay) || !date(body.toDay) || !Number.isSafeInteger(body.count) || (body.count as number) < 0 || !Array.isArray(body.occurrences) || body.occurrences.length > 100 || (body.count as number) < body.occurrences.length) throw new Error('Calendar response unavailable.');
  try { new Intl.DateTimeFormat('en-US', { timeZone: body.timezone }); } catch { throw new Error('Calendar response unavailable.'); }
  if (body.occurrences.length !== Math.min(body.count as number, 100)) throw new Error('Calendar response incomplete.');
  if (body.toDay <= body.fromDay || (owner.timezone && body.timezone !== owner.timezone) || (expectedWindow && (body.fromDay !== expectedWindow.fromDay || body.toDay !== new Date(Date.parse(`${expectedWindow.fromDay}T00:00:00Z`) + expectedWindow.days * 86_400_000).toISOString().slice(0, 10)))) throw new Error('Calendar account or window changed.');
  const keys = new Set<string>();
  for (const row of body.occurrences) {
    if (!object(row) || typeof row.eventId !== 'string' || typeof row.occurrenceKey !== 'string' || keys.has(row.occurrenceKey) || typeof row.title !== 'string' || !instant(row.starts_at) || !(row.ends_at === null || instant(row.ends_at)) || typeof row.all_day !== 'boolean' || !(row.location === null || typeof row.location === 'string') || typeof row.category !== 'string' || (row.all_day ? !date(row.startDate) || !date(row.endDate) || row.endDate <= row.startDate : row.startDate !== null || row.endDate !== null)) throw new Error('Calendar response unavailable.');
    keys.add(row.occurrenceKey);
  }
  return body as CalendarReply;
}
export function buildCalendarRequest(apiUrl: string, token: string, owner: CalendarOwner, fromDay: string, days: number, signal?: AbortSignal) {
  const url = `${apiUrl.replace(/\/+$/, '')}/api/calendar/occurrences?${new URLSearchParams({ fromDay, days: String(days), limit: '100' })}`;
  return { url, init: { method: 'GET', headers: { Authorization: `Bearer ${token}`, 'X-Bubaly-User-Id': owner.userId, 'X-Bubaly-Family-Id': owner.familyId, Accept: 'application/json' }, signal, redirect: 'error' as const } };
}
export function eventDay(row: EventRow, timezone: string) { return row.all_day ? row.startDate! : dayKey(new Date(row.starts_at), timezone); }
export function eventDayLabel(row: EventRow, timezone: string, now = new Date()) {
  if (!row.all_day) return dayLabel(new Date(row.starts_at), timezone, now);
  return dayLabel(new Date(`${row.startDate}T12:00:00Z`), 'UTC', new Date(`${dayKey(now, timezone)}T12:00:00Z`));
}
export function groupCalendarDays(rows: EventRow[], timezone: string) {
  const groups = new Map<string, { key: string; label: string; items: EventRow[] }>();
  for (const row of rows) { const key = eventDay(row, timezone); const group = groups.get(key) ?? { key, label: eventDayLabel(row, timezone), items: [] }; group.items.push(row); groups.set(key, group); }
  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
}
