import { dayKey, dayLabel, nextDayKey } from './format';

export type CalendarOwner = { userId: string; familyId: string; memberId: string; timezone?: string };
export const calendarOwnerKey = (owner: CalendarOwner | null) => owner ? JSON.stringify([owner.userId, owner.familyId, owner.memberId, owner.timezone]) : '';
type SourceTime = { kind: 'date' | 'utc' | 'floating'; value: string } | { kind: 'zoned'; value: string; tzid: string };
type CommonEvent = { occurrenceKey: string; title: string | null; starts_at: string; ends_at: string | null; all_day: boolean; location: string | null; category: string | null; startDate: string | null; endDate: string | null };
type LegacyEvent = CommonEvent & { eventId: string; kind?: never; reference?: never; readOnly?: never; actualStartsAt?: never; actualEndsAt?: never };
type NativeEvent = CommonEvent & { kind: 'native'; eventId: string; reference: { kind: 'native'; eventId: string }; readOnly: boolean; actualStartsAt: string; actualEndsAt: string | null };
type SourceEvent = CommonEvent & { kind: 'source'; eventId?: never; reference: { kind: 'source'; feedId: string; uid: string; revisionId: string; original: SourceTime }; readOnly: true; category: null; actualStartsAt: string; actualEndsAt: string };
export type EventRow = LegacyEvent | NativeEvent | SourceEvent;
export type CalendarReply = { contractVersion?: 2; userId: string; familyId: string; timezone: string; fromDay: string; toDay: string; count: number; occurrences: EventRow[] };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 8192;
// A source key encodes multiple individually bounded identities; escaping can
// double their length. Do not truncate an admitted UID or timezone identity.
const occurrenceKey = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 65_536;
const date = (v: unknown): v is string => typeof v === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(v) && v >= '0001-01-01' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
const instant = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(v) && date(v.slice(0, 10)) && +v.slice(11, 13) < 24 && +v.slice(14, 16) < 60 && +v.slice(17, 19) < 60 && Number.isFinite(Date.parse(v));
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(key => Object.hasOwn(v, key));
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (object(v)) return `{${Object.keys(v).sort().map(key => `${JSON.stringify(key)}:${stable(v[key])}`).join(',')}}`;
  return JSON.stringify(v);
}
function sourceTime(v: unknown): v is SourceTime {
  if (!object(v) || !text(v.value) || !['date', 'utc', 'floating', 'zoned'].includes(String(v.kind)) || !exact(v, v.kind === 'zoned' ? ['kind', 'value', 'tzid'] : ['kind', 'value'])) return false;
  const compact = v.value, day = `${compact.slice(0, 4)}-${compact.slice(4, 6)}-${compact.slice(6, 8)}`;
  if (!date(day)) return false;
  if (v.kind === 'date') return /^\d{8}$/.test(compact);
  if (!(v.kind === 'utc' ? /^\d{8}T\d{6}Z$/ : /^\d{8}T\d{6}$/).test(compact) || +compact.slice(9, 11) > 23 || +compact.slice(11, 13) > 59 || +compact.slice(13, 15) > 59) return false;
  return v.kind !== 'zoned' || text(v.tzid);
}
const unavailable = () => new Error('Calendar response unavailable.');
export function parseCalendarReply(body: unknown, owner: CalendarOwner, expectedWindow?: { fromDay: string; days: number }): CalendarReply {
  if (!object(body) || (body.contractVersion !== undefined && body.contractVersion !== 2) || body.userId !== owner.userId || body.familyId !== owner.familyId || typeof body.timezone !== 'string' || !date(body.fromDay) || !date(body.toDay) || !Number.isSafeInteger(body.count) || (body.count as number) < 0 || !Array.isArray(body.occurrences) || body.occurrences.length > 100 || (body.count as number) < body.occurrences.length) throw unavailable();
  try { new Intl.DateTimeFormat('en-US', { timeZone: body.timezone }); } catch { throw unavailable(); }
  if (body.occurrences.length !== Math.min(body.count as number, 100)) throw new Error('Calendar response incomplete.');
  if (body.toDay <= body.fromDay || (Date.parse(body.toDay) - Date.parse(body.fromDay)) / 86_400_000 > 31 || (owner.timezone && body.timezone !== owner.timezone) || (expectedWindow && (body.fromDay !== expectedWindow.fromDay || body.toDay !== new Date(Date.parse(`${expectedWindow.fromDay}T00:00:00Z`) + expectedWindow.days * 86_400_000).toISOString().slice(0, 10)))) throw new Error('Calendar account or window changed.');
  const keys = new Set<string>();
  const windowStart = civilBoundary(body.fromDay, body.timezone), windowEnd = civilBoundary(body.toDay, body.timezone);
  for (const row of body.occurrences) {
    if (!object(row) || !occurrenceKey(row.occurrenceKey) || keys.has(row.occurrenceKey) || !(row.title === null || typeof row.title === 'string') || !instant(row.starts_at) || !(row.ends_at === null || instant(row.ends_at)) || (row.ends_at !== null && Date.parse(row.ends_at as string) < Date.parse(row.starts_at)) || typeof row.all_day !== 'boolean' || !(row.location === null || typeof row.location === 'string') || !(row.category === null || typeof row.category === 'string') || (row.all_day ? !date(row.startDate) || !date(row.endDate) || row.endDate <= row.startDate : row.startDate !== null || row.endDate !== null)) throw unavailable();
    if (body.contractVersion === 2) {
      if (!instant(row.actualStartsAt) || !(row.actualEndsAt === null || instant(row.actualEndsAt)) || (row.actualEndsAt !== null && Date.parse(row.actualEndsAt as string) < Date.parse(row.actualStartsAt)) || typeof row.readOnly !== 'boolean' || !object(row.reference)) throw unavailable();
      if (row.kind === 'native') {
        if (!text(row.eventId) || !exact(row.reference, ['kind', 'eventId']) || row.reference.kind !== 'native' || row.reference.eventId !== row.eventId || row.occurrenceKey !== stable(['native', row.eventId, row.starts_at]) || typeof row.title !== 'string' || typeof row.category !== 'string') throw unavailable();
      } else if (row.kind === 'source') {
        const ref = row.reference;
        if (Object.hasOwn(row, 'eventId') || row.readOnly !== true || row.category !== null || row.actualEndsAt === null || !exact(ref, ['kind', 'feedId', 'uid', 'revisionId', 'original']) || ref.kind !== 'source' || !text(ref.feedId) || !text(ref.uid) || !text(ref.revisionId) || !sourceTime(ref.original) || row.occurrenceKey !== stable(['source', ref.feedId, ref.uid, ref.original])) throw unavailable();
      } else throw unavailable();
      if (!row.all_day && (Date.parse(row.actualStartsAt) !== Date.parse(row.starts_at) || (row.ends_at === null ? row.actualEndsAt !== null && Date.parse(row.actualEndsAt as string) !== Date.parse(row.starts_at) + 3_600_000 : row.actualEndsAt === null || Date.parse(row.actualEndsAt as string) !== Date.parse(row.ends_at as string)))) throw unavailable();
      if (row.all_day && (Date.parse(row.starts_at) !== Date.parse(`${row.startDate}T00:00:00Z`) || (row.ends_at !== null && Date.parse(row.ends_at as string) !== Date.parse(`${row.endDate}T00:00:00Z`)) || Date.parse(row.actualStartsAt) !== civilBoundary(row.startDate as string, body.timezone) || row.actualEndsAt === null || Date.parse(row.actualEndsAt as string) !== civilBoundary(row.endDate as string, body.timezone))) throw unavailable();
    } else if (!text(row.eventId) || row.kind !== undefined || row.reference !== undefined || row.readOnly !== undefined || row.actualStartsAt !== undefined || row.actualEndsAt !== undefined || typeof row.title !== 'string' || typeof row.category !== 'string') throw unavailable();
    const start = Date.parse(typeof row.actualStartsAt === 'string' ? row.actualStartsAt : row.starts_at);
    const end = Date.parse(typeof row.actualEndsAt === 'string' ? row.actualEndsAt : typeof row.ends_at === 'string' ? row.ends_at : new Date(start + 3_600_000).toISOString());
    const overlaps = row.all_day ? (row.startDate as string) < body.toDay && (row.endDate as string) > body.fromDay
      : start === end ? start >= windowStart && start < windowEnd : start < windowEnd && end > windowStart;
    if (!overlaps) throw unavailable();
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
/** Earliest instant on or after a civil date, including skipped midnights/dates. */
function civilBoundary(day: string, timezone: string): number {
  if (!date(day)) throw unavailable();
  const formatter = new Intl.DateTimeFormat('en-US', { calendar: 'gregory', numberingSystem: 'latn', timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', era: 'short' });
  const keyAt = (at: number) => {
    const p = Object.fromEntries(formatter.formatToParts(new Date(at)).map(part => [part.type, part.value]));
    return p.era === 'AD' ? `${p.year.padStart(4, '0')}-${p.month}-${p.day}` : '';
  };
  const center = Date.parse(`${day}T12:00:00Z`); let before = center - 3 * 86_400_000, after = center + 3 * 86_400_000;
  if (keyAt(before) >= day || keyAt(after) < day) throw unavailable();
  while (after - before > 1) { const middle = before + Math.floor((after - before) / 2); if (keyAt(middle) < day) before = middle; else after = middle; }
  return after;
}
export type CalendarDayItem = EventRow & { segmentKey: string; segmentStartsAt: string; segmentEndsAt: string };
/** Bound display segments to the requested civil window; counts remain occurrences. */
export function groupCalendarDays(rows: EventRow[], timezone: string, window?: { fromDay: string; toDay: string }, now = new Date()) {
  const groups = new Map<string, { key: string; label: string; items: CalendarDayItem[] }>();
  if (!rows.length) return [];
  const fromDay = window?.fromDay ?? rows.map(row => eventDay(row, timezone)).sort()[0];
  const toDay = window?.toDay ?? rows.map(row => row.all_day ? row.endDate! : nextDayKey(dayKey(new Date(row.ends_at ?? new Date(Date.parse(row.starts_at) + 3_600_000).toISOString()), timezone))).sort().at(-1)!;
  if (!date(fromDay) || !date(toDay) || toDay <= fromDay || (Date.parse(toDay) - Date.parse(fromDay)) / 86_400_000 > 31) throw unavailable();
  const seen = new Set<string>(); let work = 0;
  for (let day = fromDay; day < toDay; day = nextDayKey(day)) {
    const next = nextDayKey(day), start = civilBoundary(day, timezone), end = civilBoundary(next, timezone);
    for (const row of rows) {
      if (++work > 3100) throw unavailable();
      const a = row.all_day ? start : Date.parse(row.actualStartsAt ?? row.starts_at);
      const b = row.all_day ? end : Date.parse(row.actualEndsAt ?? row.ends_at ?? new Date(a + 3_600_000).toISOString());
      if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) throw unavailable();
      const occupied = row.all_day ? row.startDate! <= day && row.endDate! > day : a === b ? a >= start && a < end : a < end && b > start;
      if (!occupied || end === start && !row.all_day) continue;
      const segmentKey = JSON.stringify([row.occurrenceKey, day]); if (seen.has(segmentKey)) throw unavailable(); seen.add(segmentKey);
      const group = groups.get(day) ?? { key: day, label: dayLabel(new Date(`${day}T12:00:00Z`), 'UTC', new Date(`${dayKey(now, timezone)}T12:00:00Z`)), items: [] };
      group.items.push({ ...row, segmentKey, segmentStartsAt: new Date(Math.max(a, start)).toISOString(), segmentEndsAt: new Date(Math.min(b, end)).toISOString() }); groups.set(day, group);
    }
  }
  return [...groups.values()];
}
