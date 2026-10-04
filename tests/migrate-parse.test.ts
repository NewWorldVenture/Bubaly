import { describe, expect, it } from 'vitest';
import { parseICS, parseCSV, csvToItems, matchColumn } from '@/lib/migrate/parse';

const ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Cozi//EN
BEGIN:VEVENT
SUMMARY:Soccer Practice
DTSTART:20240514T173000Z
DTEND:20240514T190000Z
LOCATION:City Field
DESCRIPTION:Bring water\\, cleats\\nand shin guards
END:VEVENT
BEGIN:VEVENT
SUMMARY:Spring Break
DTSTART;VALUE=DATE:20240401
DTEND;VALUE=DATE:20240408
END:VEVENT
BEGIN:VEVENT
SUMMARY:Folded line event
DTSTART:20240601T090000Z
END:VEVENT
END:VCALENDAR`;

describe('parseICS', () => {
  it('parses timed events with UTC times', () => {
    const events = parseICS(ICS);
    expect(events).toHaveLength(3);
    const soccer = events[0];
    expect(soccer.title).toBe('Soccer Practice');
    expect(soccer.startsAt).toBe('2024-05-14T17:30:00.000Z');
    expect(soccer.endsAt).toBe('2024-05-14T19:00:00.000Z');
    expect(soccer.allDay).toBe(false);
    expect(soccer.location).toBe('City Field');
  });

  it('unescapes TEXT values (commas + newlines)', () => {
    const [soccer] = parseICS(ICS);
    expect(soccer.description).toBe('Bring water, cleats\nand shin guards');
  });

  it('treats VALUE=DATE as an all-day event at midnight UTC', () => {
    const springBreak = parseICS(ICS)[1];
    expect(springBreak.title).toBe('Spring Break');
    expect(springBreak.allDay).toBe(true);
    expect(springBreak.startsAt).toBe('2024-04-01T00:00:00.000Z');
  });

  it('handles line folding (continuation lines)', () => {
    const folded = 'BEGIN:VEVENT\nSUMMARY:Very long\n  title here\nDTSTART:20240101T000000Z\nEND:VEVENT';
    const [e] = parseICS(folded);
    expect(e.title).toBe('Very long title here');
  });

  it('returns nothing for an empty calendar', () => {
    expect(parseICS('BEGIN:VCALENDAR\nEND:VCALENDAR')).toHaveLength(0);
  });

  // A calendar exported from Google, Apple or Outlook publishes timed events in
  // a named zone. Reading `DTSTART;TZID=America/New_York:20260906T090000` as
  // 09:00 UTC put a 9 am practice at 5 am on the family's new calendar — every
  // timed event of the import, hours off, which is the one thing a family
  // switching providers checks first.
  describe('a timed event published in a named zone', () => {
    const zoned = (dtstart: string, dtend?: string) => parseICS([
      'BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'SUMMARY:Practice', `DTSTART;${dtstart}`, ...(dtend ? [`DTEND;${dtend}`] : []), 'END:VEVENT', 'END:VCALENDAR',
    ].join('\n'))[0];

    it('lands at the hour the zone meant, in summer and in winter', () => {
      expect(zoned('TZID=America/New_York:20260906T090000', 'TZID=America/New_York:20260906T100000'))
        .toMatchObject({ startsAt: '2026-09-06T13:00:00.000Z', endsAt: '2026-09-06T14:00:00.000Z', allDay: false });
      expect(zoned('TZID=America/New_York:20260115T090000').startsAt).toBe('2026-01-15T14:00:00.000Z');
      expect(zoned('TZID=Europe/London:20260906T090000').startsAt).toBe('2026-09-06T08:00:00.000Z');
    });

    it('reads a reading the zone skips at spring-forward as the first minute that exists', () => {
      // New York jumps from 02:00 to 03:00 on 2026-03-08; 02:30 never happens.
      expect(zoned('TZID=America/New_York:20260308T023000').startsAt).toBe('2026-03-08T07:00:00.000Z');
    });

    it('a quoted zone name with a colon in it is a parameter, not the value', () => {
      // Outlook's form. The zone is not an IANA name, so the reading falls back
      // to the floating rule — but the event is now imported at all: the first
      // colon used to split inside the parameter and the event was dropped.
      const e = zoned('TZID="(UTC-05:00) Eastern Time (US & Canada)":20260906T090000');
      expect(e).toBeDefined();
      expect(e.startsAt).toBe('2026-09-06T09:00:00.000Z');
    });

    it('a zone this runtime does not know falls back to the floating reading — the stated limit', () => {
      expect(zoned('TZID=Eastern Standard Time:20260906T090000').startsAt).toBe('2026-09-06T09:00:00.000Z');
    });

    it('leaves UTC, floating and all-day values exactly as before', () => {
      expect(parseICS(ICS)[0].startsAt).toBe('2024-05-14T17:30:00.000Z');
      expect(zoned('VALUE=DATE:20261005')).toMatchObject({ startsAt: '2026-10-05T00:00:00.000Z', allDay: true });
      expect(parseICS('BEGIN:VEVENT\nSUMMARY:Floating\nDTSTART:20260906T090000\nEND:VEVENT')[0].startsAt).toBe('2026-09-06T09:00:00.000Z');
    });
  });
});

describe('parseCSV', () => {
  it('parses headers and rows', () => {
    const t = parseCSV('Task,Notes\nDishes,After dinner\nTrash,Tuesday');
    expect(t.headers).toEqual(['Task', 'Notes']);
    expect(t.rows).toHaveLength(2);
    expect(t.rows[0]).toEqual(['Dishes', 'After dinner']);
  });

  it('handles quoted fields with commas and quotes', () => {
    const t = parseCSV('Item,Qty\n"Apples, red",3\n"He said ""hi""",1');
    expect(t.rows[0]).toEqual(['Apples, red', '3']);
    expect(t.rows[1][0]).toBe('He said "hi"');
  });

  it('ignores blank lines', () => {
    const t = parseCSV('A,B\n\n1,2\n\n');
    expect(t.rows).toHaveLength(1);
  });
});

describe('matchColumn + csvToItems', () => {
  it('matches columns case-insensitively and fuzzily', () => {
    expect(matchColumn(['Task Name', 'Due'], ['name'])).toBe(0);
    expect(matchColumn(['A', 'B'], ['zzz'])).toBe(-1);
  });

  it('maps rows to {name, extra}, skipping blanks and falling back to col 0', () => {
    const t = parseCSV('Item,Quantity\nMilk,1 gal\n,skip\nEggs,12');
    const items = csvToItems(t, ['item'], ['quantity']);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ name: 'Milk', extra: '1 gal' });
    expect(items[1]).toEqual({ name: 'Eggs', extra: '12' });
  });
});
