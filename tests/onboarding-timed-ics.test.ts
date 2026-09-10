import { describe, expect, it } from 'vitest';
import { parseIcsResult, parseIcs, toBriefEvents } from '@/lib/onboarding/ics';
import { normalizedImportEvents } from '@/lib/onboarding/ics-time';

const event = (lines: string) => 'BEGIN:VEVENT\nUID:Original-id\nSUMMARY:School: "Bring lunch\n' + lines + '\nEND:VEVENT';
const calendar = (lines: string, timezone = '') => 'BEGIN:VCALENDAR\nVERSION:2.0\n' + timezone + event(lines) + '\nEND:VCALENDAR';
const ny = 'BEGIN:VTIMEZONE\nTZID:America/New_York\nX-LIC-LOCATION:America/New_York\n'
  + 'BEGIN:DAYLIGHT\nDTSTART:19700308T020000\nTZOFFSETFROM:-0500\nTZOFFSETTO:-0400\nRRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU\nEND:DAYLIGHT\n'
  + 'BEGIN:STANDARD\nDTSTART:19701101T020000\nTZOFFSETFROM:-0400\nTZOFFSETTO:-0500\nRRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU\nEND:STANDARD\nEND:VTIMEZONE\n';
const parse = (lines: string, zone?: string, definition = '') => parseIcsResult(calendar(lines, definition), { floatingTimezone: zone });
const only = (result: ReturnType<typeof parse>) => {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.code);
  expect(result.events).toHaveLength(1);
  return result.events[0];
};

describe('strict pasted calendar time forms', () => {
  it.each(['CST', 'PST', 'IST', 'ESTERN', '/America/New_York'])('rejects ambiguous or unrecognized zone identifier %s', zone => {
    expect(parse('DTSTART;TZID=' + zone + ':20260910T090000')).toEqual({ ok: false, code: 'unsupportedTimezone' });
  });
  it.each([
    ['Cuba', '2026-09-10T13:00:00.000Z'], ['GB', '2026-09-10T08:00:00.000Z'],
    ['EST5EDT', '2026-09-10T13:00:00.000Z'], ['EST', '2026-09-10T14:00:00.000Z'],
    ['UTC', '2026-09-10T09:00:00.000Z'], ['GMT', '2026-09-10T09:00:00.000Z'],
  ])('resolves verified IANA alias %s', (zone, start) => {
    expect(only(parse('DTSTART;TZID=' + zone + ':20260910T090000')).start).toBe(start);
  });
  it('preserves explicit UTC, UID, text, and input event order', () => {
    const input = calendar('DTSTART:20260910T130001Z\nDTEND:20260910T143001Z');
    const original = only(parseIcsResult(input));
    expect(original).toMatchObject({ uid: 'Original-id', title: 'School: "Bring lunch', start: '2026-09-10T13:00:01Z', end: '2026-09-10T14:30:01Z', allDay: false });
    const result = parseIcsResult(input.replace('END:VCALENDAR', event('DTSTART:20260909T130000Z') + '\nEND:VCALENDAR'));
    expect(result.ok && result.events.map(item => item.start)).toEqual(['2026-09-10T13:00:01Z', '2026-09-09T13:00:00Z']);
  });

  it.each(['TZID=America/New_York', 'TZID="America/New_York"', 'VALUE=DATE-TIME;TZID=America/New_York'])('resolves exact parameters %s', parameters => {
    const result = parse('DTSTART;' + parameters + ':20260910T090000\nDTEND;' + parameters + ':20260910T103000', 'Asia/Tokyo');
    expect(only(result)).toMatchObject({ start: '2026-09-10T13:00:00.000Z', end: '2026-09-10T14:30:00.000Z', allDay: false });
    expect(result.ok && result.disclosure.floatingTimezone).toBeUndefined();
  });

  it('does not classify explicit DATE-TIME as DATE', () => {
    expect(only(parse('DTSTART;VALUE=DATE-TIME:20260910T130000Z'))).toMatchObject({ start: '2026-09-10T13:00:00Z', end: '2026-09-10T13:00:00Z', allDay: false });
  });

  it.each([
    ['America/New_York', '2026-09-10T13:00:00.000Z'], ['Asia/Tokyo', '2026-09-10T00:00:00.000Z'],
    ['Asia/Kathmandu', '2026-09-10T03:15:00.000Z'], ['UTC', '2026-09-10T09:00:00.000Z'],
  ])('anchors floating times to the explicit %s choice', (timezone, start) => {
    const result = parse('DTSTART:20260910T090000\nDTEND:20260910T100000', timezone);
    expect(only(result).start).toBe(start);
    expect(result.ok && result.disclosure.floatingTimezone).toBe(timezone);
  });
  it('requires an explicit choice for floating times even if VTIMEZONE is present', () => {
    expect(parse('DTSTART:20260910T090000', undefined, ny)).toEqual({ ok: false, code: 'floatingTimezoneRequired' });
  });

  it.each([
    ['America/New_York', '20260308T023000', '2026-03-08T07:30:00.000Z'],
    ['America/New_York', '20261101T013000', '2026-11-01T05:30:00.000Z'],
    ['Europe/Berlin', '20261025T023000', '2026-10-25T00:30:00.000Z'],
    ['Australia/Lord_Howe', '20261004T021500', '2026-10-03T15:45:00.000Z'],
    ['Pacific/Apia', '20111230T090000', '2011-12-30T19:00:00.000Z'],
  ])('uses the RFC gap/fold interpretation in %s at %s', (zone, value, start) => {
    expect(only(parse('DTSTART;TZID=' + zone + ':' + value)).start).toBe(start);
  });

  it('keeps genuine all-day dates and their exclusive end unshifted', () => {
    expect(only(parse('DTSTART;VALUE=DATE:20260910\nDTEND;VALUE=DATE:20260912', 'America/Los_Angeles'))).toMatchObject({
      start: '2026-09-10T00:00:00.000Z', end: '2026-09-12T00:00:00.000Z', allDay: true,
    });
    expect(only(parse('DTSTART;VALUE=DATE:20260910')).end).toBeNull();
  });

  it.each([
    'DTSTART:20260230T090000Z', 'DTSTART:20260910T240000Z', 'DTSTART:20260910T126000Z',
    'DTSTART:20260910T125960Z', 'DTSTART:20260910T090000-0400', 'DTSTART:20260910T090000.123Z',
    'DTSTART:20260910t090000Z', 'DTSTART;VALUE=DATE-TIME:20260910', 'DTSTART;VALUE=DATE:20260910T090000Z',
    'DTSTART;VALUE=DATE;TZID=America/New_York:20260910', 'DTSTART;TZID=America/New_York:20260910T130000Z',
  ])('rejects malformed or unsupported full token %s', line => expect(parse(line)).toEqual({ ok: false, code: 'invalidDate' }));

  it.each(['Custom/Office', '/vendor/America/New_York', 'Eastern Standard Time'])('rejects unsupported identifiers without guessing %s', zone => {
    expect(parse('DTSTART;TZID=' + zone + ':20260910T090000')).toEqual({ ok: false, code: 'unsupportedTimezone' });
  });
});

describe('bounded IANA VTIMEZONE declarations', () => {
  it.each(['20260110T090000', '20260710T090000', '20260308T023000', '20261101T013000'])('accepts normal New York observances for %s', time => {
    const bare = parse('DTSTART;TZID=America/New_York:' + time);
    expect(parse('DTSTART;TZID=America/New_York:' + time, undefined, ny)).toEqual(bare);
  });
  it('supports transition RDATE separately from event recurrence dates', () => {
    const definition = ny.replace('RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU', 'RDATE:20260308T020000,20270314T020000')
      .replace('RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU', 'RDATE:20261101T020000,20271107T020000');
    expect(only(parse('DTSTART;TZID=America/New_York:20260710T090000', undefined, definition)).start).toBe('2026-07-10T13:00:00.000Z');
  });
  it('supports a fixed IANA zone with a single STANDARD observance', () => {
    const definition = 'BEGIN:VTIMEZONE\nTZID:Asia/Kathmandu\nBEGIN:STANDARD\nDTSTART:19860101T000000\nTZOFFSETFROM:+0530\nTZOFFSETTO:+0545\nEND:STANDARD\nEND:VTIMEZONE\n';
    expect(only(parse('DTSTART;TZID=Asia/Kathmandu:20260710T090000', undefined, definition)).start).toBe('2026-07-10T03:15:00.000Z');
  });
  it('rejects a conflicting preceding gap transition even for a point event', () => {
    const definition = ny.replace('TZOFFSETFROM:-0500', 'TZOFFSETFROM:-0300');
    expect(parse('DTSTART;TZID=America/New_York:20260308T023000', undefined, definition))
      .toEqual({ ok: false, code: 'unsupportedTimezone' });
  });
  it('checks an intermediate imported event inside a short IANA seasonal cycle', () => {
    // Boa Vista observed DST only 8–15 October 2000 (IANA tzdb southamerica).
    // The first/last endpoints and weekly samples all use -04; the middle
    // event uses -03 and exposes a declaration that omits the short cycle.
    const definition = 'BEGIN:VTIMEZONE\nTZID:America/Boa_Vista\nBEGIN:STANDARD\nDTSTART:20000227T000000\nTZOFFSETFROM:-0300\nTZOFFSETTO:-0400\nEND:STANDARD\nEND:VTIMEZONE\n';
    const endpoints = ['20001007T233000', '20001015T003000'];
    const input = (times: string[]) => 'BEGIN:VCALENDAR\n' + definition
      + times.map(time => event('DTSTART;TZID=America/Boa_Vista:' + time)).join('\n') + '\nEND:VCALENDAR';
    expect(parseIcsResult(input(endpoints)).ok).toBe(true);
    expect(parseIcsResult(input([endpoints[0], '20001009T120000', endpoints[1]])))
      .toEqual({ ok: false, code: 'unsupportedTimezone' });
  });
  it('supports negative ordinal weekdays and a bounded historical observance', () => {
    const definition = 'BEGIN:VTIMEZONE\nTZID:Europe/Berlin\n'
      + 'BEGIN:DAYLIGHT\nDTSTART:19960331T020000\nTZOFFSETFROM:+0100\nTZOFFSETTO:+0200\nRRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU\nEND:DAYLIGHT\n'
      + 'BEGIN:STANDARD\nDTSTART:19961027T030000\nTZOFFSETFROM:+0200\nTZOFFSETTO:+0100\nRRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU;UNTIL=20271031T010000Z\nEND:STANDARD\nEND:VTIMEZONE\n';
    expect(only(parse('DTSTART;TZID=Europe/Berlin:20261025T023000', undefined, definition)).start).toBe('2026-10-25T00:30:00.000Z');
  });
  it.each([
    ny.replaceAll('America/New_York', 'Custom/Office'),
    ny.replaceAll('-0400', '-0300'),
    ny.replace('BYDAY=2SU', 'BYDAY=1SU'),
    ny.replace('BYDAY=2SU', 'BYDAY=SU;BYSETPOS=2'),
    ny.replace('BYDAY=2SU', 'BYDAY=2SU;COUNT=2'),
    ny.replace('TZID:America/New_York', 'TZID:America/New_York\nTZID:America/New_York'),
  ])('rejects custom, contradictory, duplicate, or unsupported definitions', definition => {
    const result = parse('DTSTART;TZID=America/New_York:20260305T090000\nDTEND;TZID=America/New_York:20261210T100000', undefined, definition);
    expect(result.ok).toBe(false);
  });
});

describe('event end/duration and whole-paste semantics', () => {
  it.each([
    ['PT90M', '2026-09-10T14:30:00.000Z'], ['PT1H15M30S', '2026-09-10T14:15:30.000Z'],
    ['P1D', '2026-09-11T13:00:00.000Z'], ['P1W', '2026-09-17T13:00:00.000Z'], ['+P1DT2H', '2026-09-11T15:00:00.000Z'],
  ])('resolves duration %s', (duration, end) => {
    expect(only(parse('DTSTART;TZID=America/New_York:20260910T090000\nDURATION:' + duration)).end).toBe(end);
  });
  it('adds a calendar day before elapsed hours across DST', () => {
    expect(only(parse('DTSTART;TZID=America/New_York:20260307T090000\nDURATION:P1DT2H')).end).toBe('2026-03-08T15:00:00.000Z');
    expect(only(parse('DTSTART;TZID=America/New_York:20260307T090000\nDURATION:PT24H')).end).toBe('2026-03-08T14:00:00.000Z');
  });
  it('adds nominal days from the effective start after a gap or skipped calendar date', () => {
    expect(only(parse('DTSTART;TZID=America/New_York:20260308T023000\nDURATION:P1D')).end).toBe('2026-03-09T07:30:00.000Z');
    expect(only(parse('DTSTART;TZID=Pacific/Apia:20111230T090000\nDURATION:P1D')).end).toBe('2011-12-31T19:00:00.000Z');
  });
  it('preserves date-only duration as exclusive calendar dates', () => {
    expect(only(parse('DTSTART;VALUE=DATE:20260307\nDURATION:P2D')).end).toBe('2026-03-09T00:00:00.000Z');
  });
  it('represents a missing timed end explicitly as zero duration', () => {
    const parsed = only(parse('DTSTART;TZID=America/New_York:20260910T090000'));
    expect(parsed.end).toBe(parsed.start);
    expect(normalizedImportEvents(toBriefEvents([parsed]))).toBe(true);
  });
  it('keeps alarm duration out of the event', () => {
    expect(only(parse('DTSTART:20260910T130000Z\nBEGIN:VALARM\nACTION:DISPLAY\nDESCRIPTION:Reminder\nTRIGGER:-PT15M\nDURATION:PT5M\nREPEAT:2\nEND:VALARM')).end).toBe('2026-09-10T13:00:00Z');
  });
  it.each(['-PT1H', 'P0D', 'PT', 'P', 'P1M', 'P1Y', 'P1W1D', 'P1DT', 'PT999999999999999999999H'])('rejects invalid duration %s', duration => {
    expect(parse('DTSTART:20260910T130000Z\nDURATION:' + duration)).toEqual({ ok: false, code: 'invalidDuration' });
  });
  it.each([
    'DTEND:20260910T120000Z', 'DTEND:20260910T130000Z', 'DTEND;VALUE=DATE:20260911',
    'DTEND:20260910T140000',
  ])('rejects inconsistent end %s', end => expect(parse('DTSTART:20260910T130000Z\n' + end, 'UTC')).toEqual({ ok: false, code: 'invalidRange' }));
  it('rejects both end and duration', () => {
    expect(parse('DTSTART:20260910T130000Z\nDTEND:20260910T140000Z\nDURATION:PT1H')).toEqual({ ok: false, code: 'invalidDuration' });
  });
  it('retains the raw recurring rule and discloses listed-occurrence-only import', () => {
    const result = parse('DTSTART:20260910T130000Z\nRRULE:FREQ=WEEKLY;BYDAY=TH');
    expect(only(result).rrule).toBe('FREQ=WEEKLY;BYDAY=TH');
    expect(result.ok && result.disclosure.recurring).toBe(true);
  });
  it.each(['RDATE:20260911T130000Z', 'EXDATE:20260910T130000Z', 'RECURRENCE-ID:20260910T130000Z'])('rejects event-level %s', line => {
    expect(parse('DTSTART:20260910T130000Z\n' + line)).toEqual({ ok: false, code: 'unsupportedRecurrence' });
  });
  it('never returns the valid part of a mixed invalid paste', () => {
    const text = 'BEGIN:VCALENDAR\n' + event('DTSTART:20260910T130000Z') + '\n' + event('DTSTART;TZID=Custom/Office:20260910T090000') + '\nEND:VCALENDAR';
    expect(parseIcsResult(text)).toEqual({ ok: false, code: 'unsupportedTimezone' });
    expect(parseIcs(text)).toEqual([]);
  });
  it.each([
    'DTSTART:20260910T130000Z\nDTSTART:20260910T140000Z',
    'DTSTART;VALUE=DATE-TIME;VALUE=DATE:20260910T130000Z',
    'DTSTART;TZID="":20260910T090000',
  ])('rejects duplicate or empty timing parameters', lines => expect(parse(lines).ok).toBe(false));
  it('rejects excess events or text rather than silently truncating', () => {
    expect(parseIcsResult('BEGIN:VCALENDAR\n' + Array.from({ length: 1001 }, () => event('DTSTART:20260910T130000Z')).join('\n') + '\nEND:VCALENDAR')).toEqual({ ok: false, code: 'tooManyEvents' });
    expect(parseIcsResult('x'.repeat(200001))).toEqual({ ok: false, code: 'tooManyEvents' });
  });
  it.each(['2026-02-30T09:00:00Z', '2026-09-10T09:00:00', 'garbage', '2026-09-10T09:00:00-04:00'])('rejects browser-returned unnormalized start %s', start => {
    expect(normalizedImportEvents([{ start }])).toBe(false);
  });
});
