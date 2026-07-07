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
});
