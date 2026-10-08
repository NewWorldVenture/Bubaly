import { describe, expect, it } from 'vitest';
import { groupCalendarDays, type EventRow } from '../mobile/src/lib/calendar-core';
const row = (starts_at: string, ends_at: string | null, extra = {}): EventRow => ({ eventId: 'synthetic-native', occurrenceKey: 'synthetic-occurrence', title: 'Synthetic', starts_at, ends_at, all_day: false, category: 'family', location: null, startDate: null, endDate: null, ...extra });
const duration = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 60_000;
describe('mobile bounded civil-day segments preserve original occurrence identities', () => {
  it.each([['2026-03-08', '2026-03-09', '2026-03-08T05:00:00Z', '2026-03-09T04:00:00Z', 1380], ['2026-11-01', '2026-11-02', '2026-11-01T04:00:00Z', '2026-11-02T05:00:00Z', 1500]])('retains actual elapsed length on New York %s', (fromDay, toDay, start, end, minutes) => {
    const source = row(String(start), String(end)); const groups = groupCalendarDays([source], 'America/New_York', { fromDay: String(fromDay), toDay: String(toDay) });
    expect(groups).toHaveLength(1); const segment = groups[0].items[0]; expect(duration(segment.segmentStartsAt, segment.segmentEndsAt)).toBe(minutes);
    expect(segment.starts_at).toBe(source.starts_at); expect(segment.ends_at).toBe(source.ends_at); expect(segment.eventId).toBe('synthetic-native');
  });
  it('clips an overnight interval to each requested day without moving its stored start', () => {
    const source = row('2026-10-08T03:30:00Z', '2026-10-08T05:15:00Z'); const groups = groupCalendarDays([source], 'America/New_York', { fromDay: '2026-10-07', toDay: '2026-10-09' });
    expect(groups.map(g => g.key)).toEqual(['2026-10-07', '2026-10-08']); expect(groups.map(g => duration(g.items[0].segmentStartsAt, g.items[0].segmentEndsAt))).toEqual([30, 75]);
    expect(groups.map(g => g.items[0].segmentKey)).toEqual(['2026-10-07', '2026-10-08'].map(day => JSON.stringify([source.occurrenceKey, day])));
    expect(groups.every(g => g.items[0].starts_at === source.starts_at)).toBe(true);
  });
  it.each(['America/Los_Angeles', 'Asia/Tokyo', 'Asia/Kathmandu'])('keeps DATE exclusive end in %s', timezone => {
    const source = row('2026-10-07T00:00:00Z', '2026-10-10T00:00:00Z', { all_day: true, startDate: '2026-10-07', endDate: '2026-10-10' });
    expect(groupCalendarDays([source], timezone, { fromDay: '2026-10-08', toDay: '2026-10-11' }).map(g => g.key)).toEqual(['2026-10-08', '2026-10-09']);
  });
  it('renders a point at the inclusive start, excludes the prior end and estimates only absent ends', () => {
    const groups = groupCalendarDays([row('2026-10-08T00:00:00Z', '2026-10-08T00:00:00Z'), row('2026-10-07T23:00:00Z', '2026-10-08T00:00:00Z', { occurrenceKey: 'ended' }), row('2026-10-08T01:00:00Z', null, { occurrenceKey: 'absent' })], 'UTC', { fromDay: '2026-10-08', toDay: '2026-10-09' });
    expect(groups[0].items.map(e => e.occurrenceKey)).toEqual(['synthetic-occurrence', 'absent']); expect(groups[0].items.map(e => duration(e.segmentStartsAt, e.segmentEndsAt))).toEqual([0, 60]);
  });
  it('keeps distinct repeated 01:15 fold instants', () => {
    const groups = groupCalendarDays([row('2026-11-01T05:15:00Z', '2026-11-01T05:30:00Z'), row('2026-11-01T06:15:00Z', '2026-11-01T06:30:00Z', { occurrenceKey: 'fold-second' })], 'America/New_York', { fromDay: '2026-11-01', toDay: '2026-11-02' });
    expect(groups[0].items.map(e => e.segmentStartsAt)).toEqual(['2026-11-01T05:15:00.000Z', '2026-11-01T06:15:00.000Z']);
  });
  it.each(['0001-01-01', '0099-12-31'])('keeps early Gregorian civil date %s', fromDay => {
    const toDay = new Date(Date.parse(`${fromDay}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    expect(groupCalendarDays([row(`${fromDay}T12:00:00Z`, `${fromDay}T13:00:00Z`)], 'UTC', { fromDay, toDay })[0].key).toBe(fromDay);
  });
  it('retains Apia civil DATE annotations without inventing actual duration on the skipped day', () => {
    const source = row('2011-12-29T00:00:00Z', '2012-01-01T00:00:00Z', { all_day: true, startDate: '2011-12-29', endDate: '2012-01-01' });
    const groups = groupCalendarDays([source], 'Pacific/Apia', { fromDay: '2011-12-29', toDay: '2012-01-01' });
    expect(groups.map(g => g.key)).toEqual(['2011-12-29', '2011-12-30', '2011-12-31']);
    expect(duration(groups[1].items[0].segmentStartsAt, groups[1].items[0].segmentEndsAt)).toBe(0);
    expect(groupCalendarDays([row('2011-12-29T10:00:00Z', '2011-12-31T10:00:00Z')], 'Pacific/Apia', { fromDay: '2011-12-29', toDay: '2012-01-01' }).map(g => g.key)).toEqual(['2011-12-29', '2011-12-31']);
  });
  it.each(['bad-zone', 'reversed', 'duplicate', 'oversize-window'])('refuses %s without partial segments', fault => {
    const a = row('2026-10-08T12:00:00Z', '2026-10-08T13:00:00Z');
    if (fault === 'reversed') a.ends_at = '2026-10-08T11:00:00Z';
    expect(() => groupCalendarDays(fault === 'duplicate' ? [a, a] : [a], fault === 'bad-zone' ? 'Invalid/Zone' : 'UTC', { fromDay: '2026-10-08', toDay: fault === 'oversize-window' ? '2027-10-09' : '2026-10-09' })).toThrow();
  });
});
