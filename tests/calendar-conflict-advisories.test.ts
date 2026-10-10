import { describe, expect, it } from 'vitest';
import type { CalendarAvailabilityOccurrence } from '@/lib/calendar/availability';
import type { Tables } from '@/lib/database.types';
import { buildConflictAdvisories, conflictSubject } from '@/lib/calendar/conflict-advisories';
import { allDayBusyInterval } from '@/lib/calendar/event-dates';
import { detectConflicts } from '@/lib/home/conflicts';
import { freeGaps } from '@/lib/calendar/scheduling';

const FAMILY = '10000000-0000-4000-8000-000000000001', FEED = '20000000-0000-4000-8000-000000000001';
const REVISION = '30000000-0000-4000-8000-000000000001', MEMBER = '50000000-0000-4000-8000-000000000001';
const start = '2026-10-08T09:00:00Z', end = '2026-10-08T10:00:00Z';
function source(index = 1, patch: Partial<CalendarAvailabilityOccurrence> = {}): CalendarAvailabilityOccurrence {
  return { kind: 'source', occurrenceKey: `source-${index}`, reference: { kind: 'source', feedId: FEED, uid: `uid-${index}`, revisionId: REVISION, original: { kind: 'utc', value: '20261008T090000Z' } },
    readOnly: true, transparency: 'opaque', title: `Source ${index}`, description: null, location: null, category: null, assignee_id: null,
    starts_at: start, ends_at: end, actualStartsAt: start, actualEndsAt: end, all_day: false, startDate: null, endDate: null,
    attribution: { kind: 'family', reason: 'source-unmapped' }, interval: { start: Date.parse(start), end: Date.parse(end) }, occupied: true, point: false, estimatedEnd: false,
    ...patch } as CalendarAvailabilityOccurrence;
}
function native(index = 1, patch: Partial<Tables<'calendar_events'>> = {}): CalendarAvailabilityOccurrence {
  const event = { id: `40000000-0000-4000-8000-${String(index).padStart(12, '0')}`, family_id: FAMILY,
    title: `Native ${index}`, description: null, location: null, category: 'general', assignee_id: MEMBER,
    starts_at: start, ends_at: end, all_day: false, feed_id: null, external_uid: null, ...patch } as Tables<'calendar_events'>;
  const estimatedEnd = !event.all_day && event.ends_at === null;
  const actualEnd = event.ends_at === null ? Date.parse(event.starts_at) + 3_600_000 : Date.parse(event.ends_at);
  return { ...source(index), kind: 'native', occurrenceKey: `native-${index}`, event, reference: { kind: 'native', eventId: event.id },
    title: event.title, category: event.category, assignee_id: event.assignee_id, starts_at: event.starts_at, ends_at: event.ends_at,
    actualStartsAt: event.starts_at, actualEndsAt: event.ends_at, all_day: event.all_day,
    readOnly: event.feed_id !== null || event.external_uid !== null,
    attribution: event.assignee_id === null ? { kind: 'family', reason: 'native-unassigned' } : { kind: 'member', memberId: event.assignee_id },
    interval: { start: Date.parse(event.starts_at), end: actualEnd }, estimatedEnd,
    point: !event.all_day && actualEnd === Date.parse(event.starts_at), occupied: actualEnd > Date.parse(event.starts_at) } as CalendarAvailabilityOccurrence;
}
function run(rows: CalendarAvailabilityOccurrence[], timezone = 'UTC') { return buildConflictAdvisories(rows, { timezone }); }
describe('exact microsecond overlap and free gap decisions', () => {
  const at = (fraction: string) => `2026-10-08T09:00:00.${fraction}Z`;
  function exact(row: CalendarAvailabilityOccurrence, start: string, end: string): CalendarAvailabilityOccurrence {
    return { ...row, starts_at: start, ends_at: end, actualStartsAt: start, actualEndsAt: end,
      ...(row.kind === 'native' ? { event: { ...row.event, starts_at: start, ends_at: end } } : {}),
      interval: { start: Date.parse(start), end: Date.parse(end) }, exactInterval: { start, end },
      point: start === end, occupied: start !== end };
  }
  it('emits a genuine source/native overlap entirely inside one millisecond with original subject endpoints', () => {
    const rows = [exact(source(), at('000001'), at('000009')), exact(native(), at('000003'), at('000007'))];
    const result = run(rows); expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ startsAt: at('000003'), endsAt: at('000007') });
    expect(result[0].subjects.map(subject => [subject.actualStartsAt, subject.actualEndsAt])).toEqual([[at('000001'), at('000009')], [at('000003'), at('000007')]]);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
  it('keeps microsecond touching boundaries and explicit equal-endpoint points conflict free', () => {
    expect(run([exact(source(), at('000001'), at('000003')), exact(native(), at('000003'), at('000007'))])).toEqual([]);
    expect(run([exact(source(), at('000001'), at('000009')), exact(native(), at('000003'), at('000003'))])).toEqual([]);
  });
  it('retains both exact free gaps around submillisecond busy time even when all numeric projections coincide', () => {
    const window = { start: at('000001'), end: at('000009') };
    const gaps = freeGaps([{ start: Date.parse(at('000003')), end: Date.parse(at('000007')), exactInterval: { start: at('000003'), end: at('000007') } }], Date.parse(window.start), Date.parse(window.end), window);
    expect(gaps.map(gap => gap.exactInterval)).toEqual([{ start: at('000001'), end: at('000003') }, { start: at('000007'), end: at('000009') }]);
    expect(gaps.every(gap => gap.start === gap.end)).toBe(true);
  });
});
function timed(row: CalendarAvailabilityOccurrence, from: string, to: string): CalendarAvailabilityOccurrence {
  return { ...row, starts_at: from, ends_at: to, actualStartsAt: from, actualEndsAt: to,
    interval: { start: Date.parse(from), end: Date.parse(to) }, point: from === to, occupied: Date.parse(to) > Date.parse(from) };
}
function date(day: string, next: string, timezone: string): CalendarAvailabilityOccurrence {
  const interval = allDayBusyInterval({ starts_at: `${day}T00:00:00Z`, ends_at: `${next}T00:00:00Z`, all_day: true }, timezone);
  return source(1, { reference: { kind: 'source', feedId: FEED, uid: 'date', revisionId: REVISION, original: { kind: 'date', value: day.replaceAll('-', '') } },
    starts_at: `${day}T00:00:00Z`, ends_at: `${next}T00:00:00Z`, actualStartsAt: new Date(interval.start).toISOString(), actualEndsAt: new Date(interval.end).toISOString(),
    all_day: true, startDate: day, endDate: next, interval, occupied: interval.end > interval.start });
}

describe('source-involved conservative family advisories', () => {
  it('keeps native personal double-booking separate, including unassigned and DATE exclusions', () => {
    const rows = [native(1), native(2), native(3, { assignee_id: null })];
    expect(run(rows)).toEqual([]);
    expect(detectConflicts(rows)).toMatchObject([{ assigneeId: MEMBER, eventIds: [rows[0].reference.kind === 'native' ? rows[0].reference.eventId : '', rows[1].reference.kind === 'native' ? rows[1].reference.eventId : ''] }]);
    expect(detectConflicts([date('2026-10-08', '2026-10-09', 'UTC'), ...rows.slice(2)])).toEqual([]);
  });
  it('emits family pairs for source/native and source/source without member inference', () => {
    const rows = [source(1), source(2), native(1, { assignee_id: null }), native(2)];
    const result = run(rows);
    expect(result).toHaveLength(5);
    expect(result.every(item => item.kind === 'family-source-overlap' && item.scope === 'family')).toBe(true);
    expect(result.every(item => item.startsAt === '2026-10-08T09:00:00.000Z' && item.endsAt === '2026-10-08T10:00:00.000Z')).toBe(true);
    expect(result.flatMap(item => item.subjects).filter(item => item.kind === 'source').every(item => item.readOnly && !item.mutable && !('eventId' in item))).toBe(true);
    expect(result.flatMap(item => item.subjects).every(item => !('memberId' in item))).toBe(true);
  });
  it('preserves escaped long UID/original moved occurrence reference and real native action ID separately', () => {
    const row = source();
    if (row.kind !== 'source') throw new Error('fixture');
    row.reference.uid = 'uid\\,;"'.padEnd(4096, 'x');
    row.reference.original = { kind: 'zoned', value: '20261001T090000', tzid: 'Custom/Zone\\;"' };
    const result = run([row, native()])[0];
    const imported = result.subjects.find(item => item.kind === 'source')!;
    expect(imported.reference).toEqual(row.reference);
    expect(imported.occurrenceKey).toBe(row.occurrenceKey);
    const local = result.subjects.find(item => item.kind === 'native')!;
    expect(local).toMatchObject({ eventId: '40000000-0000-4000-8000-000000000001', occurrenceKey: 'native-1', mutable: true, readOnly: false });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
  it('retains readonly legacy imported native subjects with genuine IDs and no mutable action', () => {
    const row = native(1, { feed_id: FEED, external_uid: 'legacy' });
    expect(conflictSubject(row)).toMatchObject({ kind: 'native', eventId: '40000000-0000-4000-8000-000000000001', mutable: false, readOnly: true });
    expect(run([source(), row])[0].subjects.find(item => item.kind === 'native')?.mutable).toBe(false);
    expect(conflictSubject(native(2, { external_uid: '' }))).toMatchObject({ mutable: false, readOnly: true });
  });
  it('preserves qualified textual native scope/member IDs while action IDs stay genuine UUIDs', () => {
    const row = native(1, { family_id: 'fam-1', assignee_id: 'M' });
    expect(run([source(), row])).toHaveLength(1);
    expect(detectConflicts([row, native(2, { family_id: 'fam-1', assignee_id: 'M' })])[0].assigneeId).toBe('M');
  });
  it('excludes free annotations, explicit points and touching half-open boundaries', () => {
    const free = source(1, { transparency: 'transparent', occupied: false });
    const point = timed(source(2), start, start);
    const touching = timed(source(3), end, '2026-10-08T11:00:00Z');
    expect(run([free, point, native()])).toEqual([]);
    expect(run([touching, native()])).toEqual([]);
    expect(run([source(), native(1, { ends_at: start })])).toEqual([]);
  });
  it('retains native missing-end one-hour estimates and source zero-duration distinctions', () => {
    const result = run([source(), native(1, { ends_at: null })]);
    expect(result).toHaveLength(1);
    expect(result[0].subjects.find(item => item.kind === 'native')?.actualEndsAt).toBeNull();
    expect(run([timed(source(), start, start), native(1, { ends_at: null })])).toEqual([]);
  });
  it('clips ongoing overlap while preserving original actual clocks', () => {
    const row = timed(source(), '2026-10-07T23:00:00Z', '2026-10-08T10:00:00Z');
    row.interval.start = Date.parse('2026-10-08T09:30:00Z');
    const result = run([row, native()])[0];
    expect(result).toMatchObject({ startsAt: '2026-10-08T09:30:00.000Z', endsAt: '2026-10-08T10:00:00.000Z' });
    expect(result.subjects.find(item => item.kind === 'source')?.actualStartsAt).toBe('2026-10-07T23:00:00Z');
  });
  for (const [day, next, hours, from, to] of [
    ['2026-03-08', '2026-03-09', 23, '2026-03-08T08:00:00.000Z', '2026-03-09T07:00:00.000Z'],
    ['2026-11-01', '2026-11-02', 25, '2026-11-01T07:00:00.000Z', '2026-11-02T08:00:00.000Z'],
  ] as const) it(`explicit opaque DATE policy occupies the ${hours}-hour LA day`, () => {
    const row = date(day, next, 'America/Los_Angeles');
    expect(row.interval.end - row.interval.start).toBe(hours * 3_600_000);
    const other = timed(source(2), from, to);
    expect(run([row, other], 'America/Los_Angeles')[0]).toMatchObject({ startsAt: from, endsAt: to });
    expect(run([{ ...row, transparency: 'transparent', occupied: false }, other], 'America/Los_Angeles')).toEqual([]);
  });
  it('a skipped civil DATE has zero elapsed occupancy', () => {
    const row = date('2011-12-30', '2011-12-31', 'Pacific/Apia');
    expect(row.interval).toEqual({ start: Date.parse('2011-12-30T10:00:00Z'), end: Date.parse('2011-12-30T10:00:00Z') });
    expect(run([row, timed(source(2), '2011-12-30T09:00:00Z', '2011-12-30T11:00:00Z')], 'Pacific/Apia')).toEqual([]);
  });
  it('uses elapsed overlap across a fall DST fold', () => {
    const a = timed(source(1), '2026-11-01T01:30:00-07:00', '2026-11-01T01:30:00-08:00');
    const b = timed(source(2), '2026-11-01T01:45:00-07:00', '2026-11-01T01:15:00-08:00');
    expect(run([a, b], 'America/Los_Angeles')[0]).toMatchObject({ startsAt: '2026-11-01T08:45:00.000Z', endsAt: '2026-11-01T09:15:00.000Z' });
  });
  it('deduplicates coherent rows even when reference keys are ordered differently', () => {
    const row = source(), duplicate = structuredClone(row);
    if (duplicate.kind !== 'source') throw new Error('fixture');
    duplicate.reference = { uid: duplicate.reference.uid, original: duplicate.reference.original, revisionId: REVISION, kind: 'source', feedId: FEED };
    expect(run([row, duplicate, native()])).toHaveLength(1);
  });
  for (const [name, corrupt] of [
    ['missing transparency', (row: CalendarAvailabilityOccurrence) => { delete (row as Partial<CalendarAvailabilityOccurrence>).transparency; }],
    ['unknown kind', (row: CalendarAvailabilityOccurrence) => { Object.assign(row, { kind: 'other' }); }],
    ['source member inference', (row: CalendarAvailabilityOccurrence) => { row.assignee_id = MEMBER; }],
    ['source action ID', (row: CalendarAvailabilityOccurrence) => { Object.assign(row, { id: native().reference }); }],
    ['missing readonly', (row: CalendarAvailabilityOccurrence) => { row.readOnly = false; }],
    ['invalid actual clock', (row: CalendarAvailabilityOccurrence) => { row.actualStartsAt = '2026-02-30T09:00:00Z'; }],
    ['invalid alias', (row: CalendarAvailabilityOccurrence) => { row.starts_at = '2026-10-08T08:00:00Z'; }],
    ['invalid interval', (row: CalendarAvailabilityOccurrence) => { row.interval.end = NaN; }],
    ['invalid original', (row: CalendarAvailabilityOccurrence) => { if (row.kind === 'source') row.reference.original.value = '20260230T090000Z'; }],
    ['UID too long', (row: CalendarAvailabilityOccurrence) => { if (row.kind === 'source') row.reference.uid = 'x'.repeat(4097); }],
    ['UID controls', (row: CalendarAvailabilityOccurrence) => { if (row.kind === 'source') row.reference.uid = 'bad\nuid'; }],
    ['source native reference', (row: CalendarAvailabilityOccurrence) => { Object.assign(row, { reference: native().reference }); }],
  ] as const) it(`refuses ${name} even on a free row before any skip`, () => {
    const row = source(2, { transparency: 'transparent', occupied: false }); corrupt(row);
    expect(() => run([source(), native(), row])).toThrow('Calendar unavailable');
  });
  it('refuses contradictory duplicates before free/point/outside-window skips', () => {
    for (const patch of [{ transparency: 'transparent', occupied: false }, { title: 'changed' }, { interval: { start: 0, end: 0 }, occupied: false }]) {
      expect(() => run([source(), { ...source(), ...patch } as CalendarAvailabilityOccurrence])).toThrow();
    }
    const point = timed(source(), start, start);
    expect(() => run([point, { ...point, title: 'changed' }])).toThrow();
  });
  it('refuses DATE civil aliases and wrong household-clock endpoints', () => {
    const row = date('2026-03-08', '2026-03-09', 'America/Los_Angeles');
    expect(() => run([row], 'UTC')).toThrow();
    expect(() => run([{ ...row, starts_at: '2026-03-08T01:00:00Z' }], 'America/Los_Angeles')).toThrow();
  });
  it('refuses corrupted native mutability, assignment, estimate and occupancy metadata', () => {
    for (const patch of [{ readOnly: true }, { assignee_id: null }, { estimatedEnd: true }, { point: true }, { occupied: false }]) {
      expect(() => run([{ ...native(), ...patch } as CalendarAvailabilityOccurrence])).toThrow();
    }
  });
  it('refuses invalid timezone and row limits without returning a prefix', () => {
    expect(() => run([], 'Mars/Olympus')).toThrow();
    expect(() => run(Array.from({ length: 20_001 }, () => source()))).toThrow();
  });
  it('does not charge source scan budget for dense native-only calendars after qualification', () => {
    expect(run(Array.from({ length: 710 }, (_, index) => native(index + 1)))).toEqual([]);
    expect(() => run([...Array.from({ length: 710 }, (_, index) => native(index + 1)), { ...native(711), point: true }])).toThrow();
  });
  it('refuses an exhausted source comparison scan even when the final result would be empty', () => {
    const rows = Array.from({ length: 710 }, (_, index) => timed(source(index + 1),
      new Date(Date.parse(start) + index * 120_000).toISOString(), new Date(Date.parse(start) + index * 120_000 + 60_000).toISOString()));
    expect(() => run(rows)).toThrow();
  });
  it('refuses advisory output exhaustion instead of truncating', () => {
    expect(() => run(Array.from({ length: 102 }, (_, index) => source(index + 1)))).toThrow();
  });
});
