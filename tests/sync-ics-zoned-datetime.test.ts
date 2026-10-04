import { describe, expect, it } from 'vitest';
import { parseICS } from '@/lib/sync/ics';

const calendar = (start: string, end?: string, definitions = '') => [
  'BEGIN:VCALENDAR', 'VERSION:2.0', definitions, 'BEGIN:VEVENT', 'UID:synthetic-zoned', 'SUMMARY:Synthetic event',
  start, ...(end ? [end] : []), 'END:VEVENT', 'END:VCALENDAR',
].join('\r\n');

describe('standard ICS explicit IANA DATE-TIME', () => {
  it.each([
    ['America/New_York', '20260621T090000', '2026-06-21T13:00:00.000Z'],
    ['America/New_York', '20260115T090000', '2026-01-15T14:00:00.000Z'],
    ['America/New_York', '20261101T013000', '2026-11-01T05:30:00.000Z'],
    ['America/New_York', '20260308T023015', '2026-03-08T07:30:15.000Z'],
    ['Europe/Berlin', '20261025T023000', '2026-10-25T00:30:00.000Z'],
    ['Europe/Berlin', '20260329T023000', '2026-03-29T01:30:00.000Z'],
    ['Australia/Lord_Howe', '20261004T021500', '2026-10-03T15:45:00.000Z'],
    ['Australia/Lord_Howe', '20260405T014500', '2026-04-04T14:45:00.000Z'],
    ['Pacific/Apia', '20111230T090000', '2011-12-30T19:00:00.000Z'],
    ['Asia/Kathmandu', '20260621T090030', '2026-06-21T03:15:30.000Z'],
  ])('resolves %s %s with first-fold and pre-gap offsets', (zone, value, expected) => {
    expect(parseICS(calendar(`DTSTART;TZID=${zone}:${value}`))[0]).toMatchObject({ startsAt: expected, allDay: false });
  });
  it('reads quoted case-insensitive parameters and each endpoint own zone', () => {
    const event = parseICS(calendar('DTSTART;vAlUe="date-time";tZiD="America/New_York":20260621T090000',
      'DTEND;TZID="America/Chicago";VALUE=DATE-TIME:20260621T090000'))[0];
    expect(event.startsAt).toBe('2026-06-21T13:00:00.000Z');
    expect(event.endsAt).toBe('2026-06-21T14:00:00.000Z');
  });
  it('unfolds a timezone parameter without consulting the host timezone', () => {
    expect(parseICS(calendar('DTSTART;TZID=America/\r\n New_York:20260621T090000'))[0].startsAt).toBe('2026-06-21T13:00:00.000Z');
  });
  it('preserves DATE and UTC tokens without converting them through a calendar display zone', () => {
    expect(parseICS(calendar('DTSTART;VALUE=DATE:20260621', 'DTEND;VALUE=DATE:20260623', 'X-WR-TIMEZONE:America/New_York'))[0])
      .toMatchObject({ startsAt: '2026-06-21T00:00:00.000Z', endsAt: '2026-06-23T00:00:00.000Z', allDay: true });
    expect(parseICS(calendar('DTSTART:20260621T090000Z'))[0].startsAt).toBe('2026-06-21T09:00:00.000Z');
  });
  it('keeps the explicitly qualified legacy floating UTC assumption', () => {
    expect(parseICS(calendar('DTSTART:20260621T090000', undefined, 'X-WR-TIMEZONE:America/New_York'))[0].startsAt)
      .toBe('2026-06-21T09:00:00.000Z');
  });
  it.each([
    'DTSTART;TZID=Unknown/Zone:20260621T090000',
    'DTSTART;TZID="Custom:America/New_York":20260621T090000',
    'DTSTART;TZID=/vendor/America/New_York:20260621T090000',
    'DTSTART;TZID=America/New_York:20260621T090000Z',
    'DTSTART;VALUE=DATE;TZID=America/New_York:20260621',
    'DTSTART;VALUE=DATE:20260621T090000',
    'DTSTART;VALUE=DATE-TIME:20260621',
    'DTSTART;TZID=:20260621T090000',
    'DTSTART;TZID=America/New_York;TZID=Europe/Berlin:20260621T090000',
    'DTSTART;TZID="America/New_York:20260621T090000',
    'DTSTART;TZID=America/New_York:20260230T090000',
    'DTSTART;TZID=America/New_York:20260621T250000',
    'DTSTART;TZID=America/New_York:20260621T090060',
  ])('rejects unsupported or contradictory temporal data visibly (%s)', line => {
    expect(() => parseICS(calendar(line))).toThrow();
  });
  it('rejects a bad DTEND rather than returning an apparently valid partial event', () => {
    expect(() => parseICS(calendar('DTSTART:20260621T090000Z', 'DTEND;TZID=Unknown/Zone:20260621T100000'))).toThrow();
  });
  it.each(['TZID:America/New_York', 'TZID;X-SYNTHETIC=label:America/New_York',
    'tZiD;X-SYNTHETIC="a:b;c":America/New_York'])
    ('does not disregard a referenced supplied definition with property %s', property => {
    const declaration = ['BEGIN:VTIMEZONE', property, 'BEGIN:STANDARD', 'DTSTART:19700101T000000',
      'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0100', 'END:STANDARD', 'END:VTIMEZONE'].join('\r\n');
    expect(() => parseICS(calendar('DTSTART;TZID=America/New_York:20260621T090000', undefined, declaration))).toThrow(/VTIMEZONE/);
    expect(parseICS(calendar('DTSTART:20260621T090000Z', undefined, declaration))[0].startsAt).toBe('2026-06-21T09:00:00.000Z');
  });
});
