import { describe, expect, it } from 'vitest';
import { expandSourceRule, type CivilDateTime } from '@/lib/calendar/source-rule';
import { parseICSSource } from '@/lib/sync/ics-source';
import type { SourceTime } from '@/lib/calendar/imported-source';
import fidelity from './fixtures/calendar-source-fidelity.json';

const DAY = 86_400_000;
function utc(civil: CivilDateTime): number {
  const date = new Date(0); date.setUTCFullYear(civil.year, civil.month - 1, civil.day);
  date.setUTCHours(civil.hour, civil.minute, civil.second, 0); return date.getTime();
}
const horizon = Date.parse('2200-01-01T00:00:00Z');
function values(start: string, rule: string, through = horizon): string[] {
  return expandSourceRule({ start: { kind: 'utc', value: start }, rule, resolve: utc, through }).map(item => item.original.value);
}
const ny = (civil: CivilDateTime): number | null => {
  if (civil.year === 2025 && civil.month === 3 && civil.day === 9 && civil.hour === 2) return null;
  const dst = civil.month > 3 && civil.month < 11 || civil.month === 3 && (civil.day > 9 || civil.day === 9 && civil.hour >= 3);
  return utc(civil) + (dst ? 4 : 5) * 3_600_000;
};

describe('bounded RFC recurrence candidates, separate from event-set exceptions', () => {
  it.each([
    ['SECONDLY', '20250101T090000Z', 'FREQ=SECONDLY;INTERVAL=20;COUNT=4', ['20250101T090000Z', '20250101T090020Z', '20250101T090040Z', '20250101T090100Z']],
    ['MINUTELY expands seconds', '20250101T090010Z', 'FREQ=MINUTELY;BYSECOND=10,30;COUNT=4', ['20250101T090010Z', '20250101T090030Z', '20250101T090110Z', '20250101T090130Z']],
    ['HOURLY expands minutes', '20250101T091000Z', 'FREQ=HOURLY;BYMINUTE=10,30;COUNT=4', ['20250101T091000Z', '20250101T093000Z', '20250101T101000Z', '20250101T103000Z']],
    ['DAILY intersects clocks', '20250101T091000Z', 'FREQ=DAILY;BYHOUR=9,17;BYMINUTE=10;COUNT=4', ['20250101T091000Z', '20250101T171000Z', '20250102T091000Z', '20250102T171000Z']],
    ['weekly interval/wkst', '19970805T090000Z', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,SU;WKST=MO;COUNT=4', ['19970805T090000Z', '19970810T090000Z', '19970819T090000Z', '19970824T090000Z']],
    ['weekly Sunday wkst', '19970805T090000Z', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,SU;WKST=SU;COUNT=4', ['19970805T090000Z', '19970817T090000Z', '19970819T090000Z', '19970831T090000Z']],
    ['monthly ordinal', '20250127T090000Z', 'FREQ=MONTHLY;BYDAY=-1MO;COUNT=3', ['20250127T090000Z', '20250224T090000Z', '20250331T090000Z']],
    ['monthly default invalid omissions', '20250131T090000Z', 'FREQ=MONTHLY;COUNT=3', ['20250131T090000Z', '20250331T090000Z', '20250531T090000Z']],
    ['yearly leap century omissions', '20960229T090000Z', 'FREQ=YEARLY;COUNT=3', ['20960229T090000Z', '21040229T090000Z', '21080229T090000Z']],
    ['yearly BYYEARDAY intersection', '20250101T090000Z', 'FREQ=YEARLY;BYYEARDAY=1;BYMONTH=1;COUNT=2', ['20250101T090000Z', '20260101T090000Z']],
    ['year ordinal', '20250106T090000Z', 'FREQ=YEARLY;BYDAY=1MO;COUNT=3', ['20250106T090000Z', '20260105T090000Z', '20270104T090000Z']],
    ['year month ordinal', '20250106T090000Z', 'FREQ=YEARLY;BYMONTH=1,2;BYDAY=1MO;COUNT=4', ['20250106T090000Z', '20250203T090000Z', '20260105T090000Z', '20260202T090000Z']],
    ['year month default day', '20250115T090000Z', 'FREQ=YEARLY;BYMONTH=1,2;COUNT=4', ['20250115T090000Z', '20250215T090000Z', '20260115T090000Z', '20260215T090000Z']],
    ['year monthday expands months', '20250115T090000Z', 'FREQ=YEARLY;BYMONTHDAY=15;COUNT=3', ['20250115T090000Z', '20250215T090000Z', '20250315T090000Z']],
    ['negative yearday', '20241231T090000Z', 'FREQ=YEARLY;BYYEARDAY=-1;COUNT=3', ['20241231T090000Z', '20251231T090000Z', '20261231T090000Z']],
    ['weekyear spill', '20200101T090000Z', 'FREQ=YEARLY;BYWEEKNO=1;BYDAY=WE;COUNT=7', ['20200101T090000Z', '20210106T090000Z', '20220105T090000Z', '20230104T090000Z', '20240103T090000Z', '20250101T090000Z', '20251231T090000Z']],
    ['negative week spill', '20241229T090000Z', 'FREQ=YEARLY;BYWEEKNO=-1;BYDAY=SU;COUNT=3', ['20241229T090000Z', '20251228T090000Z', '20270103T090000Z']],
    ['positions deduplicate', '20250101T090000Z', 'FREQ=DAILY;BYHOUR=9;BYSETPOS=1,-1;COUNT=3', ['20250101T090000Z', '20250102T090000Z', '20250103T090000Z']],
    ['hour filters', '20250101T090000Z', 'FREQ=MINUTELY;BYHOUR=9;BYMINUTE=0,30;BYSECOND=0;COUNT=3', ['20250101T090000Z', '20250101T093000Z', '20250102T090000Z']],
  ] as const)('%s', (_name, start, rule, expected) => { expect(values(start, rule)).toEqual(expected); });

  it('includes a week-year occurrence before its January period anchor at the exact query horizon', () => {
    expect(values('20240101T090000Z', 'FREQ=YEARLY;BYWEEKNO=1;BYDAY=MO;COUNT=4', Date.parse('2025-12-29T09:00:00Z'))).toEqual(['20240101T090000Z', '20241230T090000Z', '20251229T090000Z']);
  });
  it('intersects monthday and weekday selectors instead of unioning them', () => {
    expect(values('20250113T090000Z', 'FREQ=MONTHLY;BYMONTHDAY=13,14,15;BYDAY=MO;COUNT=3')).toEqual(['20250113T090000Z', '20250414T090000Z', '20250714T090000Z']);
  });
  it('handles Gregorian years below100 without the JS1900 offset', () => {
    expect(values('00010101T090000Z', 'FREQ=YEARLY;COUNT=3')).toEqual(['00010101T090000Z', '00020101T090000Z', '00030101T090000Z']);
  });
  it('ignores time selectors on DATE rules and compares DATE UNTIL inclusively', () => {
    const result = expandSourceRule({ start: { kind: 'date', value: '20250101' }, rule: 'FREQ=DAILY;BYHOUR=19;BYMINUTE=59;BYSECOND=60;UNTIL=20250103', resolve: utc, through: Date.parse('2025-01-10T00:00:00Z') });
    expect(result.map(item => item.original.value)).toEqual(['20250101', '20250102', '20250103']);
  });
  it('compares floating UNTIL in the source clock despite nonzero offsets', () => {
    const result = expandSourceRule({ start: { kind: 'floating', value: '20250101T090000' }, rule: 'FREQ=DAILY;UNTIL=20250103T090000', resolve: civil => utc(civil) - 10 * 3_600_000, through: Date.parse('2025-01-10T00:00:00Z') });
    expect(result.map(item => item.original.value)).toEqual(['20250101T090000', '20250102T090000', '20250103T090000']);
  });
  it('applies BYSETPOS to the full first/last frequency period before horizon clipping', () => {
    const result = values('20250101T090000Z', 'FREQ=DAILY;BYHOUR=9,17;BYSETPOS=1;COUNT=3', Date.parse('2025-01-02T10:00:00Z'));
    expect(result).toEqual(['20250101T090000Z', '20250102T090000Z']);
  });
  it.each(['ny-gap', 'lord-howe-gap', 'apia-gap', 'valid-byyearday-intersection', 'utc-until', 'bysetpos-gap', 'negative-bysetpos-control'])('executes correct source fixture %s through injected synthetic clock', id => {
    const fixture = fidelity.cases.find(item => item.id === id)!;
    const document = parseICSSource(fixture.ical!)[0], master = document.master!;
    const resolve = id === 'lord-howe-gap' ? (value: CivilDateTime) => value.month === 10 && value.day === 6 && value.hour === 2 && value.minute < 30 ? null : utc(value) - ((value.month > 10 || value.month === 10 && value.day >= 6) ? 11 : 10.5) * 3_600_000
      : id === 'apia-gap' ? (value: CivilDateTime) => value.year === 2011 && value.month === 12 && value.day === 30 ? null : utc(value) + (value.year === 2011 && value.month === 12 && value.day < 30 ? 10 : -14) * 3_600_000
        : id === 'valid-byyearday-intersection' ? utc : ny;
    const result = expandSourceRule({ start: master.dtstart!, rule: master.rrule!, resolve, through: Date.parse('2030-01-01T00:00:00Z') });
    expect(result.map(item => item.original.value)).toEqual(fixture.expected.recurrenceIds);
    if ('utcInstants' in fixture.expected) expect(result.map(item => new Date(item.instant).toISOString())).toEqual(fixture.expected.utcInstants!.map(value => new Date(value).toISOString()));
  });
  it('does not replenish COUNT after the later event-set EXDATE filter', () => {
    const result = expandSourceRule({ start: { kind: 'zoned', tzid: 'America/New_York', value: '20250308T023000' }, rule: 'FREQ=DAILY;COUNT=3', resolve: ny, through: Date.parse('2025-04-01T00:00:00Z') });
    expect(result.map(item => item.original.value)).toEqual(['20250308T023000', '20250310T023000', '20250311T023000']);
    expect(result.filter(item => item.original.value !== '20250310T023000').map(item => item.original.value)).toEqual(['20250308T023000', '20250311T023000']);
  });
  it('counts an explicit gap DTSTART once using its pre-gap offset, then generates valid later slots', () => {
    const start: SourceTime = { kind: 'zoned', tzid: 'America/New_York', value: '20250309T023000' };
    const result = expandSourceRule({ start, rule: 'FREQ=DAILY;COUNT=2', resolve: ny, resolveStart: value => utc(value) + 5 * 3_600_000, through: Date.parse('2025-04-01T00:00:00Z') });
    expect(result.map(item => item.original.value)).toEqual(['20250309T023000', '20250310T023000']);
    expect(result.map(item => new Date(item.instant).toISOString())).toEqual(['2025-03-09T07:30:00.000Z', '2025-03-10T06:30:00.000Z']);
    expect(result.filter(item => item.original.value !== start.value).map(item => item.original.value)).toEqual(['20250310T023000']);
  });
  it('uses the explicit first-fold seed without changing its recurrence identity or double counting', () => {
    const start: SourceTime = { kind: 'zoned', tzid: 'America/New_York', value: '20251102T013000' };
    const result = expandSourceRule({ start, rule: 'FREQ=DAILY;COUNT=2', resolve: value => utc(value) + (value.day === 2 ? 4 : 5) * 3_600_000, resolveStart: value => utc(value) + 4 * 3_600_000, through: Date.parse('2025-11-10T00:00:00Z') });
    expect(result.map(item => item.original.value)).toEqual(['20251102T013000', '20251103T013000']);
    expect(new Date(result[0].instant).toISOString()).toBe('2025-11-02T05:30:00.000Z');
  });
  it('does not let the explicit seed seam fabricate an inconsistent DTSTART or unqualified gap-position interaction', () => {
    const start: SourceTime = { kind: 'zoned', tzid: 'America/New_York', value: '20250309T023000' };
    const options = { start, resolve: ny, resolveStart: (value: CivilDateTime) => utc(value) + 5 * 3_600_000, through: horizon };
    expect(() => expandSourceRule({ ...options, rule: 'FREQ=DAILY;BYHOUR=17;COUNT=2' })).toThrow(/does not match/);
    expect(() => expandSourceRule({ ...options, rule: 'FREQ=DAILY;BYHOUR=2,3;BYSETPOS=1;COUNT=2' })).toThrow(/separate qualification/);
  });
  it('removes gaps before negative positions and preserves the original source timezone identity', () => {
    const start: SourceTime = { kind: 'zoned', tzid: 'America/New_York', value: '20250308T023000' };
    const result = expandSourceRule({ start, rule: 'FREQ=DAILY;BYHOUR=1,2,3;BYSETPOS=-2;COUNT=3', resolve: ny, through: Date.parse('2025-04-01T00:00:00Z') });
    expect(result.map(item => item.original.value)).toEqual(['20250308T023000', '20250309T013000', '20250310T023000']);
    expect(result.every(item => item.original.kind === 'zoned' && item.original.tzid === start.tzid)).toBe(true);
  });
  it.each([
    ['unknown selectors', 'FREQ=YEARLY;BYEASTER=1'], ['illegal week ordinal', 'FREQ=YEARLY;BYWEEKNO=1;BYDAY=1MO'],
    ['undefined DTSTART synchronization', 'FREQ=DAILY;BYHOUR=17;COUNT=2'], ['unsupported leap second expansion', 'FREQ=MINUTELY;BYSECOND=0,60;COUNT=2'],
  ])('refuses %s explicitly', (_name, rule) => { expect(() => values('20250101T090000Z', rule)).toThrow(); });
  it('never returns a success prefix when work/output bounds are exhausted', () => {
    const options = { start: { kind: 'utc', value: '20250101T090000Z' } as SourceTime, rule: 'FREQ=DAILY;COUNT=5', resolve: utc, through: horizon };
    expect(() => expandSourceRule({ ...options, maxWork: 2 })).toThrow(/work bound/);
    expect(() => expandSourceRule({ ...options, maxOccurrences: 2 })).toThrow(/output bound/);
    expect(expandSourceRule(options)).toHaveLength(5);
  });
  it('charges every candidate operation to a shared outer budget and propagates exhaustion', () => {
    let remaining = 20;
    const options = { start: { kind: 'utc', value: '20250101T090000Z' } as SourceTime, rule: 'FREQ=DAILY;COUNT=3', resolve: utc, through: horizon,
      consumeWork: () => { if (--remaining < 0) throw new Error('shared clock budget exhausted'); } };
    expect(expandSourceRule(options)).toHaveLength(3);
    expect(() => expandSourceRule(options)).toThrow(/shared clock budget exhausted/);
  });
  it('refuses malformed horizon, invalid clock outputs, and propagates clock qualification failures', () => {
    const options = { start: { kind: 'utc', value: '20250101T090000Z' } as SourceTime, rule: 'FREQ=DAILY;COUNT=1', resolve: utc, through: horizon };
    expect(() => expandSourceRule({ ...options, through: NaN })).toThrow(/horizon/);
    expect(() => expandSourceRule({ ...options, resolve: () => NaN })).toThrow(/clock/);
    expect(() => expandSourceRule({ ...options, resolve: civil => utc(civil) + 3 * DAY })).toThrow(/offset/);
    expect(() => expandSourceRule({ ...options, resolve: () => { throw new Error('unqualified source clock'); } })).toThrow(/unqualified source clock/);
  });
});
