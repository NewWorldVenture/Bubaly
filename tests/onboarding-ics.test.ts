import { describe, it, expect } from 'vitest';
import { parseIcs, toBriefEvents, demoBriefEvents, parseIcsDate } from '@/lib/onboarding/ics';
import { buildFirstBrief } from '@/lib/onboarding/first-brief';

const SAMPLE = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:evt-1
SUMMARY:Soccer practice
LOCATION:Field 3
DTSTART:20260707T160000Z
DTEND:20260707T173000Z
RRULE:FREQ=WEEKLY;BYDAY=TU
END:VEVENT
BEGIN:VEVENT
UID:evt-2
SUMMARY:School holiday
DTSTART;VALUE=DATE:20260708
END:VEVENT
BEGIN:VEVENT
UID:evt-3
SUMMARY:Folded desc test
DESCRIPTION:Line one\\nstill line one
DTSTART:20260709T090000Z
END:VEVENT
END:VCALENDAR`;

describe('parseIcs', () => {
  it('parses VEVENTs with times, all-day dates, and rrule', () => {
    const events = parseIcs(SAMPLE);
    expect(events).toHaveLength(3);
    const soccer = events[0];
    expect(soccer.title).toBe('Soccer practice');
    expect(soccer.location).toBe('Field 3');
    expect(soccer.start).toBe('2026-07-07T16:00:00Z');
    expect(soccer.end).toBe('2026-07-07T17:30:00Z');
    expect(soccer.rrule).toContain('WEEKLY');
    expect(soccer.allDay).toBe(false);
  });

  it('treats VALUE=DATE as an all-day event', () => {
    const holiday = parseIcs(SAMPLE)[1];
    expect(holiday.allDay).toBe(true);
    expect(holiday.start).toBe('2026-07-08T00:00:00.000Z');
  });

  it('unescapes description text', () => {
    const e = parseIcs(SAMPLE)[2];
    expect(e.notes).toBe('Line one\nstill line one');
  });

  it('returns [] for junk or empty input instead of throwing', () => {
    expect(parseIcs('')).toEqual([]);
    expect(parseIcs('not a calendar')).toEqual([]);
    // @ts-expect-error — defensive against non-string
    expect(parseIcs(null)).toEqual([]);
  });

  it('maps parsed events to brief events with a recurring flag', () => {
    const brief = toBriefEvents(parseIcs(SAMPLE));
    expect(brief[0].recurring).toBe(true);
    expect(brief[1].recurring).toBe(false);
    expect(brief.every((e) => typeof e.start === 'string')).toBe(true);
  });
});

describe('parseIcsDate', () => {
  it('handles date-only and datetime tokens', () => {
    expect(parseIcsDate('DTSTART;VALUE=DATE', '20260708')).toBe('2026-07-08T00:00:00.000Z');
    expect(parseIcsDate('DTSTART', '20260707T160000Z')).toBe('2026-07-07T16:00:00Z');
    expect(parseIcsDate('DTSTART', 'garbage')).toBe('');
  });
});

describe('demoBriefEvents', () => {
  it('generates a week anchored on now with a same-day clash to show value', () => {
    const now = new Date('2026-07-07T12:00:00.000Z');
    const events = demoBriefEvents(now);
    expect(events.length).toBeGreaterThanOrEqual(10);
    const brief = buildFirstBrief(events, now);
    expect(brief.todayCount).toBeGreaterThan(0);
    expect(brief.conflicts.length).toBeGreaterThan(0);        // soccer vs dentist
    expect(brief.timeSavedMinutes).toBeGreaterThan(0);
    expect(brief.actions.some((a) => a.kind === 'conflict')).toBe(true);
  });

  it.each([
    ['America/New_York', '2026-09-10T00:00:00Z', '2026-09-09', '2026-09-09T13:00:00.000Z', '2026-09-10T19:30:00.000Z'],
    ['America/Los_Angeles', '2026-09-10T02:00:00Z', '2026-09-09', '2026-09-09T16:00:00.000Z', '2026-09-10T22:30:00.000Z'],
    ['Asia/Tokyo', '2026-09-09T22:30:00Z', '2026-09-10', '2026-09-10T00:00:00.000Z', '2026-09-11T06:30:00.000Z'],
    ['Asia/Kathmandu', '2026-09-09T22:30:00Z', '2026-09-10', '2026-09-10T03:15:00.000Z', '2026-09-11T09:45:00.000Z'],
    ['America/New_York', '2026-03-07T17:00:00Z', '2026-03-07', '2026-03-07T14:00:00.000Z', '2026-03-08T19:30:00.000Z'],
    ['America/New_York', '2026-10-31T16:00:00Z', '2026-10-31', '2026-10-31T13:00:00.000Z', '2026-11-01T20:30:00.000Z'],
  ])('keeps the sample schedule on the family calendar in %s at %s', (timezone, instant, date, standup, piano) => {
    const now = new Date(instant);
    const events = demoBriefEvents(now, timezone);
    expect(events[0].start).toBe(standup); expect(events[4].start).toBe(piano);
    const brief = buildFirstBrief(events, now, [], timezone);
    expect(brief.todayCount).toBe(4);
    expect(brief.timeline.map(row => row.timeLabel)).toEqual(['9:00 AM', '4:00 PM', '4:30 PM', '6:30 PM']);
    expect(brief.conflicts[0]).toMatchObject({ aTitle: 'Soccer practice', bTitle: 'Dentist — Mia', dayLabel: 'Today', overlapLabel: '4:30 PM–5:15 PM' });
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
    const keys = events.map(event => day.format(new Date(event.start)));
    const expectedOffsets = [0, 0, 0, 0, 1, 1, 2, 2, 3, 4, 5, 6];
    expect(keys).toEqual(expectedOffsets.map(offset => new Date(Date.parse(`${date}T12:00:00Z`) + offset * 86400_000).toISOString().slice(0, 10)));
    expect(events.map(event => (Date.parse(event.end!) - Date.parse(event.start)) / 60_000)).toEqual([30, 90, 45, 60, 60, 60, 180, 60, 90, 90, 120, 90]);
    const omitTime = ({ start: _start, end: _end, ...content }: (typeof events)[number]) => content;
    expect(events.map(omitTime)).toEqual(demoBriefEvents(now).map(omitTime));
  });

  it('keeps the original UTC schedule and payload exactly when timezone is omitted', () => {
    const now = new Date('2026-09-10T00:00:00Z');
    const legacy = demoBriefEvents(now);
    expect(legacy[0].start).toBe('2026-09-10T09:00:00.000Z');
    expect(legacy.at(-1)?.start).toBe('2026-09-16T09:00:00.000Z');
    expect(demoBriefEvents(now, 'UTC')).toEqual(legacy);
  });

  it('does not silently generate another day for an invalid supplied zone or clock', () => {
    expect(() => demoBriefEvents(new Date('2026-09-10T00:00:00Z'), 'Invalid/Zone')).toThrow(RangeError);
    expect(() => demoBriefEvents(new Date('invalid'), 'America/New_York')).toThrow(RangeError);
  });
});
