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
