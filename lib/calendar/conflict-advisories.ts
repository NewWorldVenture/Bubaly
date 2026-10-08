import type { CalendarAvailabilityOccurrence } from './availability';
import type { CalendarSnapshotReference } from './source-snapshot';
import { allDayBusyInterval } from './event-dates';
import { validDay } from '../onboarding/ics-time';
import { isValidTimezone } from '../time/zoned';

type SubjectCommon = {
  occurrenceKey: string; title: string | null; readOnly: boolean; mutable: boolean;
  actualStartsAt: string; actualEndsAt: string | null;
};
export type CalendarConflictSubject = SubjectCommon & (
  | { kind: 'native'; reference: Extract<CalendarSnapshotReference, { kind: 'native' }>; eventId: string }
  | { kind: 'source'; reference: Extract<CalendarSnapshotReference, { kind: 'source' }>; readOnly: true; mutable: false }
);
export type CalendarConflictAdvisory = {
  kind: 'family-source-overlap'; scope: 'family'; startsAt: string; endsAt: string;
  subjects: [CalendarConflictSubject, CalendarConflictSubject];
};

const MAX_ROWS = 20_000, MAX_COMPARISONS = 250_000, MAX_ADVISORIES = 5_000;
function fail(): never { throw new Error('Calendar unavailable. Please refresh and try again.'); }
function uuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
function identity(value: unknown, max = 4096): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && !/[\u0000-\u0008\u000a-\u001f\u007f]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);
}
function instant(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || !validDay(value.slice(0, 10)) || +value.slice(11, 13) > 23 || +value.slice(14, 16) > 59 || +value.slice(17, 19) > 59) fail();
  const result = Date.parse(value);
  if (!Number.isFinite(result)) fail();
  return result;
}
function exactKeys(value: object, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function reference(row: CalendarAvailabilityOccurrence): void {
  if (!row || !identity(row.occurrenceKey, 32_768) || typeof row.readOnly !== 'boolean'
    || row.title !== null && (typeof row.title !== 'string' || row.title.length > 65_536) || !row.reference) fail();
  const ref = row.reference;
  if (row.kind === 'source') {
    if (ref.kind !== 'source' || !exactKeys(ref, ['kind', 'feedId', 'uid', 'revisionId', 'original'])
      || !uuid(ref.feedId) || !uuid(ref.revisionId) || !identity(ref.uid) || !ref.original
      || row.readOnly !== true || row.assignee_id !== null || row.category !== null || 'event' in row || 'id' in row) fail();
    const original = ref.original;
    if (!['date', 'utc', 'zoned', 'floating'].includes(original.kind)
      || !exactKeys(original, original.kind === 'zoned' ? ['kind', 'value', 'tzid'] : ['kind', 'value'])
      || !identity(original.value) || original.kind === 'zoned' && !identity(original.tzid)) fail();
    const value = original.value, day = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
    if (!validDay(day) || (original.kind === 'date') !== row.all_day
      || !(original.kind === 'date' ? /^\d{8}$/ : original.kind === 'utc' ? /^\d{8}T\d{6}Z$/ : /^\d{8}T\d{6}$/).test(value)
      || original.kind !== 'date' && (+value.slice(9, 11) > 23 || +value.slice(11, 13) > 59 || +value.slice(13, 15) > 59)) fail();
  } else if (row.kind === 'native') {
    if (ref.kind !== 'native' || !exactKeys(ref, ['kind', 'eventId']) || !uuid(ref.eventId) || !row.event
      || row.event.id !== ref.eventId || !identity(row.event.family_id)
      || row.event.feed_id !== null && !uuid(row.event.feed_id)
      || row.event.external_uid !== null && typeof row.event.external_uid !== 'string'
      || row.readOnly !== (row.event.feed_id !== null || row.event.external_uid !== null)
      || row.assignee_id !== row.event.assignee_id || row.assignee_id !== null && !identity(row.assignee_id)
      || row.category !== row.event.category || row.starts_at !== row.event.starts_at || row.ends_at !== row.event.ends_at
      || row.all_day !== row.event.all_day) fail();
  } else fail();
}

/** For already qualified availability rows. Native action IDs are separate from
 * occurrence identities; publisher-owned native copies remain read-only. */
export function conflictSubject(row: CalendarAvailabilityOccurrence): CalendarConflictSubject {
  reference(row);
  const common = { occurrenceKey: row.occurrenceKey, title: row.title, actualStartsAt: row.actualStartsAt, actualEndsAt: row.actualEndsAt };
  if (row.kind === 'native') return { ...common, kind: 'native', reference: { kind: 'native', eventId: row.reference.eventId },
    eventId: row.reference.eventId, readOnly: row.readOnly, mutable: !row.readOnly };
  const ref = row.reference, clock = ref.original;
  const original = clock.kind === 'zoned' ? { kind: clock.kind, value: clock.value, tzid: clock.tzid } : { kind: clock.kind, value: clock.value };
  return { ...common, kind: 'source', reference: { kind: 'source', feedId: ref.feedId, uid: ref.uid, revisionId: ref.revisionId, original }, readOnly: true, mutable: false };
}

function qualify(row: CalendarAvailabilityOccurrence, timezone: string): void {
  reference(row);
  if (typeof row.all_day !== 'boolean' || (row.transparency !== 'opaque' && row.transparency !== 'transparent')
    || row.kind === 'native' && row.transparency !== 'opaque' || typeof row.occupied !== 'boolean'
    || typeof row.point !== 'boolean' || typeof row.estimatedEnd !== 'boolean' || !row.attribution || !row.interval) fail();
  if (row.kind === 'source') {
    if (row.attribution.kind !== 'family' || row.attribution.reason !== 'source-unmapped' || row.estimatedEnd) fail();
  } else if (row.assignee_id === null) {
    if (row.attribution.kind !== 'family' || row.attribution.reason !== 'native-unassigned') fail();
  } else if (row.attribution.kind !== 'member' || row.attribution.memberId !== row.assignee_id) fail();
  const start = instant(row.actualStartsAt);
  const estimated = row.kind === 'native' && !row.all_day && row.event.ends_at === null;
  const end = row.actualEndsAt === null && estimated ? start + 3_600_000 : instant(row.actualEndsAt);
  if (end < start || row.estimatedEnd !== estimated || row.point !== (!row.all_day && start === end)) fail();
  if (row.all_day) {
    if (typeof row.startDate !== 'string' || typeof row.endDate !== 'string' || !validDay(row.startDate)
      || !validDay(row.endDate) || row.endDate <= row.startDate
      || instant(row.starts_at) !== Date.parse(`${row.startDate}T00:00:00Z`)
      || row.ends_at !== null && instant(row.ends_at) !== Date.parse(`${row.endDate}T00:00:00Z`)) fail();
    const expected = allDayBusyInterval({ starts_at: `${row.startDate}T00:00:00Z`, ends_at: `${row.endDate}T00:00:00Z`, all_day: true }, timezone);
    if (start !== expected.start || end !== expected.end) fail();
  } else if (row.startDate !== null || row.endDate !== null || start !== instant(row.starts_at)
    || end !== (row.ends_at === null && estimated ? start + 3_600_000 : instant(row.ends_at))) fail();
  const { start: clippedStart, end: clippedEnd } = row.interval;
  if (!Number.isFinite(clippedStart) || !Number.isFinite(clippedEnd) || clippedEnd < clippedStart
    || clippedEnd > clippedStart && (clippedStart < start || clippedEnd > end)
    || row.occupied !== (row.transparency === 'opaque' && clippedEnd > clippedStart)) fail();
}

/** Conservative FAMILY occupancy pairs involving at least one source. DATEs
 * occupy their qualified household civil interval (including 23/25-hour days;
 * skipped dates have no elapsed occupancy). Free annotations, points and touching
 * half-open boundaries cannot clash. Personal native double-booking stays separate.
 * Qualification/deduplication precede every skip; any budget exhaustion refuses
 * the complete result rather than publishing a calm or truncated prefix. */
export function buildConflictAdvisories(
  records: readonly CalendarAvailabilityOccurrence[], options: { timezone: string },
): CalendarConflictAdvisory[] {
  if (!Array.isArray(records) || records.length > MAX_ROWS || !options || !isValidTimezone(options.timezone)) fail();
  const unique = new Map<string, { row: CalendarAvailabilityOccurrence; signature: string }>();
  for (const row of records) {
    qualify(row, options.timezone);
    // Explicit field order makes coherent reference object key order irrelevant.
    const signature = JSON.stringify([conflictSubject(row), row.transparency, row.all_day, row.startDate, row.endDate,
      row.starts_at, row.ends_at, row.interval.start, row.interval.end, row.occupied, row.point, row.estimatedEnd,
      row.assignee_id, row.category, row.description, row.location,
      row.kind === 'native' ? [row.event.feed_id, row.event.external_uid] : null]);
    const previous = unique.get(row.occurrenceKey);
    if (previous && previous.signature !== signature) fail();
    if (!previous) unique.set(row.occurrenceKey, { row, signature });
  }
  const occupied = [...unique.values()].map(item => item.row).filter(row => row.occupied)
    .sort((a, b) => a.interval.start - b.interval.start || a.occurrenceKey.localeCompare(b.occurrenceKey));
  const result: CalendarConflictAdvisory[] = [];
  let comparisons = 0;
  for (let i = 0; i < occupied.length; i++) {
    const left = occupied[i];
    if (left.kind !== 'source') continue;
    for (let j = 0; j < occupied.length; j++) {
      if (++comparisons > MAX_COMPARISONS) fail();
      const right = occupied[j];
      if (right.interval.start >= left.interval.end) break;
      if (i === j || right.kind === 'source' && j < i || right.interval.end <= left.interval.start) continue;
      if (result.length >= MAX_ADVISORIES) fail();
      result.push({ kind: 'family-source-overlap', scope: 'family',
        startsAt: new Date(Math.max(left.interval.start, right.interval.start)).toISOString(),
        endsAt: new Date(Math.min(left.interval.end, right.interval.end)).toISOString(),
        subjects: j < i ? [conflictSubject(right), conflictSubject(left)] : [conflictSubject(left), conflictSubject(right)] });
    }
  }
  return result.sort((a, b) => a.startsAt.localeCompare(b.startsAt)
    || a.subjects[0].occurrenceKey.localeCompare(b.subjects[0].occurrenceKey)
    || a.subjects[1].occurrenceKey.localeCompare(b.subjects[1].occurrenceKey));
}
