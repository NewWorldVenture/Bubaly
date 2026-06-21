import { describe, expect, it } from 'vitest';
import {
  generateICS, parseICS, escapeIcsText, unescapeIcsText, foldLine,
  toIcsUtc, toIcsDate, type IcsEvent,
} from '@/lib/sync/ics';

const DTSTAMP = '2026-06-20T12:00:00.000Z';

describe('ICS text escaping (RFC 5545 §3.3.11)', () => {
  it('escapes backslash, comma, semicolon, and newline', () => {
    expect(escapeIcsText('a,b;c\\d\ne')).toBe('a\\,b\\;c\\\\d\\ne');
  });
  it('round-trips through unescape', () => {
    const s = 'Dinner; bring: salad, bread\nand wine \\ cheese';
    expect(unescapeIcsText(escapeIcsText(s))).toBe(s);
  });
});

describe('line folding (RFC 5545 §3.1)', () => {
  it('leaves short lines untouched', () => {
    expect(foldLine('SHORT:line')).toBe('SHORT:line');
  });
  it('folds long lines to <=75 octets with CRLF + space continuation', () => {
    const long = 'DESCRIPTION:' + 'x'.repeat(200);
    const folded = foldLine(long);
    const lines = folded.split('\r\n');
    expect(lines[0].length).toBe(75);
    for (let i = 1; i < lines.length; i++) {
      expect(lines[i].startsWith(' ')).toBe(true);
      expect(lines[i].length).toBeLessThanOrEqual(75);
    }
  });
});

describe('date formatting', () => {
  it('formats UTC datetime', () => {
    expect(toIcsUtc('2026-06-20T14:30:00.000Z')).toBe('20260620T143000Z');
  });
  it('formats all-day DATE', () => {
    expect(toIcsDate('2026-06-20T00:00:00.000Z')).toBe('20260620');
  });
  it('throws on invalid input', () => {
    expect(() => toIcsUtc('not-a-date')).toThrow();
  });
});

describe('generateICS', () => {
  const events: IcsEvent[] = [
    {
      uid: 'evt-1@bubaly.com',
      title: 'Soccer practice',
      location: 'Field A',
      startsAt: '2026-06-21T17:00:00.000Z',
      endsAt: '2026-06-21T18:30:00.000Z',
      updatedAt: '2026-06-20T09:00:00.000Z',
    },
    {
      uid: 'evt-2@bubaly.com',
      title: 'Family trip',
      startsAt: '2026-07-01T00:00:00.000Z',
      endsAt: '2026-07-05T00:00:00.000Z',
      allDay: true,
      recurrenceRule: 'FREQ=YEARLY',
    },
  ];

  it('produces a well-formed VCALENDAR', () => {
    const ics = generateICS(events, { name: 'Family', dtstamp: DTSTAMP });
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.trimEnd().endsWith('END:VCALENDAR')).toBe(true);
    expect(ics).toContain('VERSION:2.0');
    expect((ics.match(/BEGIN:VEVENT/g) ?? []).length).toBe(2);
    expect(ics.endsWith('\r\n')).toBe(true);
  });

  it('emits timed events as UTC and all-day events as VALUE=DATE', () => {
    const ics = generateICS(events, { name: 'Family', dtstamp: DTSTAMP });
    expect(ics).toContain('DTSTART:20260621T170000Z');
    expect(ics).toContain('DTEND:20260621T183000Z');
    expect(ics).toContain('DTSTART;VALUE=DATE:20260701');
    expect(ics).toContain('RRULE:FREQ=YEARLY');
  });

  it('uses the event updatedAt as DTSTAMP when present', () => {
    const ics = generateICS([events[0]], { name: 'Family', dtstamp: DTSTAMP });
    expect(ics).toContain('DTSTAMP:20260620T090000Z');
  });
});

describe('generate -> parse round trip', () => {
  it('recovers event fields from generated ICS', () => {
    const original: IcsEvent[] = [{
      uid: 'rt-1@bubaly.com',
      title: 'Lunch, with the; team',
      description: 'line one\nline two',
      location: 'Cafe',
      startsAt: '2026-06-22T11:00:00.000Z',
      endsAt: '2026-06-22T12:00:00.000Z',
    }];
    const ics = generateICS(original, { name: 'RT', dtstamp: DTSTAMP });
    const parsed = parseICS(ics);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].uid).toBe('rt-1@bubaly.com');
    expect(parsed[0].title).toBe('Lunch, with the; team');
    expect(parsed[0].description).toBe('line one\nline two');
    expect(parsed[0].startsAt).toBe('2026-06-22T11:00:00.000Z');
    expect(parsed[0].allDay).toBe(false);
  });

  it('parses all-day events as DATE with allDay=true', () => {
    const ics = generateICS(
      [{ uid: 'ad@x', title: 'Holiday', startsAt: '2026-12-25T00:00:00.000Z', allDay: true }],
      { name: 'AD', dtstamp: DTSTAMP },
    );
    const parsed = parseICS(ics);
    expect(parsed[0].allDay).toBe(true);
    expect(parsed[0].startsAt).toBe('2026-12-25T00:00:00.000Z');
  });

  it('handles folded long descriptions on unfold', () => {
    const desc = 'y'.repeat(300);
    const ics = generateICS(
      [{ uid: 'fold@x', title: 'T', description: desc, startsAt: '2026-06-22T11:00:00.000Z' }],
      { name: 'F', dtstamp: DTSTAMP },
    );
    const parsed = parseICS(ics);
    expect(parsed[0].description).toBe(desc);
  });
});
