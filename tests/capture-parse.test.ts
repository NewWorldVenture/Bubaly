import { describe, it, expect } from 'vitest';
import { parseEvent, parseDueDate, suggestKind, splitItems, parseGroceryItem } from '@/lib/capture/parse';

// Fixed reference: Friday 2026-06-26, 10:00 local.
const NOW = new Date(2026, 5, 26, 10, 0, 0, 0);

function ymd(d: Date) { return [d.getFullYear(), d.getMonth() + 1, d.getDate()]; }

describe('parseEvent — time of day', () => {
  it('parses "at 3pm" today (future time)', () => {
    const r = parseEvent('Dentist at 3pm', NOW);
    expect(r.title).toBe('Dentist');
    expect(r.allDay).toBe(false);
    expect(r.matched).toBe(true);
    expect(r.startsAt.getHours()).toBe(15);
    expect(r.startsAt.getMinutes()).toBe(0);
    expect(ymd(r.startsAt)).toEqual([2026, 6, 26]);
  });

  it('parses "3:30 pm" with minutes', () => {
    const r = parseEvent('Call mom 3:30 pm', NOW);
    expect(r.startsAt.getHours()).toBe(15);
    expect(r.startsAt.getMinutes()).toBe(30);
    expect(r.title).toBe('Call mom');
  });

  it('rolls a past time forward to tomorrow', () => {
    const r = parseEvent('Standup at 9am', NOW); // 9am already passed at 10:00
    expect(ymd(r.startsAt)).toEqual([2026, 6, 27]);
    expect(r.startsAt.getHours()).toBe(9);
  });

  it('parses 24-hour times', () => {
    const r = parseEvent('Meeting 15:30', NOW);
    expect(r.startsAt.getHours()).toBe(15);
    expect(r.startsAt.getMinutes()).toBe(30);
  });

  it('parses noon and midnight', () => {
    expect(parseEvent('Lunch noon', NOW).startsAt.getHours()).toBe(12);
    const mid = parseEvent('Alarm midnight', NOW);
    expect(mid.startsAt.getHours()).toBe(0);
  });
});

describe('parseEvent — day references', () => {
  it('parses "tomorrow" as an all-day event', () => {
    const r = parseEvent('Trash day tomorrow', NOW);
    expect(ymd(r.startsAt)).toEqual([2026, 6, 27]);
    expect(r.allDay).toBe(true);
    expect(r.title).toBe('Trash day');
  });

  it('combines day + time: "tomorrow at 3pm"', () => {
    const r = parseEvent('Dentist tomorrow at 3pm', NOW);
    expect(ymd(r.startsAt)).toEqual([2026, 6, 27]);
    expect(r.startsAt.getHours()).toBe(15);
    expect(r.allDay).toBe(false);
    expect(r.title).toBe('Dentist');
  });

  it('"tonight" implies the evening today', () => {
    const r = parseEvent('Movie tonight', NOW);
    expect(ymd(r.startsAt)).toEqual([2026, 6, 26]);
    expect(r.startsAt.getHours()).toBe(19);
    expect(r.allDay).toBe(false);
  });

  it('bare weekday resolves to the coming occurrence', () => {
    // NOW is Friday; "monday" → next Monday 2026-06-29.
    const r = parseEvent('Soccer monday', NOW);
    expect(ymd(r.startsAt)).toEqual([2026, 6, 29]);
  });

  it('same weekday as today jumps a week', () => {
    const r = parseEvent('Review friday', NOW); // today is Friday
    expect(ymd(r.startsAt)).toEqual([2026, 7, 3]);
  });

  it('"next <weekday>" pushes a further week out', () => {
    const r = parseEvent('Trip next monday', NOW);
    expect(ymd(r.startsAt)).toEqual([2026, 7, 6]);
  });

  it('parses "in 3 days" and "in 2 weeks"', () => {
    expect(ymd(parseEvent('Renew in 3 days', NOW).startsAt)).toEqual([2026, 6, 29]);
    expect(ymd(parseEvent('Checkup in 2 weeks', NOW).startsAt)).toEqual([2026, 7, 10]);
  });
});

describe('parseEvent — fallbacks', () => {
  it('keeps the raw title and "now" when nothing is recognized', () => {
    const r = parseEvent('Buy a gift', NOW);
    expect(r.matched).toBe(false);
    expect(r.title).toBe('Buy a gift');
    expect(r.startsAt.getTime()).toBe(NOW.getTime());
    expect(r.allDay).toBe(false);
  });

  it('never returns an empty title', () => {
    const r = parseEvent('tomorrow', NOW);
    expect(r.title.length).toBeGreaterThan(0);
  });
});

describe('parseDueDate', () => {
  it('sets a due date from a day reference and cleans the title', () => {
    expect(parseDueDate('Pay rent friday', NOW)).toEqual({ title: 'Pay rent', dueDate: '2026-07-03' });
    expect(parseDueDate('Renew passport in 2 weeks', NOW)).toEqual({ title: 'Renew passport', dueDate: '2026-07-10' });
    expect(parseDueDate('Trash tomorrow', NOW)).toEqual({ title: 'Trash', dueDate: '2026-06-27' });
  });

  it('strips a trailing time alongside the day', () => {
    expect(parseDueDate('Submit report friday at 5pm', NOW)).toEqual({ title: 'Submit report', dueDate: '2026-07-03' });
  });

  it('does not set a due date for a bare time or no day', () => {
    expect(parseDueDate('Call the plumber', NOW)).toEqual({ title: 'Call the plumber', dueDate: null });
    expect(parseDueDate('Standup at 9am', NOW)).toEqual({ title: 'Standup at 9am', dueDate: null });
  });
});

describe('splitItems', () => {
  it('splits comma lists and drops a leading buy verb', () => {
    expect(splitItems('Buy milk, eggs, bread')).toEqual(['milk', 'eggs', 'bread']);
    expect(splitItems('milk; eggs; bread')).toEqual(['milk', 'eggs', 'bread']);
  });

  it('treats "and" as a separator only when a comma is present', () => {
    expect(splitItems('milk, eggs and bread')).toEqual(['milk', 'eggs', 'bread']);
    expect(splitItems('macaroni and cheese')).toEqual(['macaroni and cheese']);
  });

  it('trims, dedupes case-insensitively, and drops blanks', () => {
    expect(splitItems('Milk,  milk , , Eggs')).toEqual(['Milk', 'Eggs']);
  });

  it('returns a single item for a plain entry', () => {
    expect(splitItems('paper towels')).toEqual(['paper towels']);
  });
});

describe('parseGroceryItem', () => {
  it('parses leading counts', () => {
    expect(parseGroceryItem('2 milk')).toEqual({ name: 'milk', quantity: '2' });
    expect(parseGroceryItem('12 eggs')).toEqual({ name: 'eggs', quantity: '12' });
    expect(parseGroceryItem('2x soda')).toEqual({ name: 'soda', quantity: '2' });
  });
  it('parses trailing counts', () => {
    expect(parseGroceryItem('milk x2')).toEqual({ name: 'milk', quantity: '2' });
    expect(parseGroceryItem('eggs (12)')).toEqual({ name: 'eggs', quantity: '12' });
  });
  it('leaves plain names and "2% milk" untouched', () => {
    expect(parseGroceryItem('bananas')).toEqual({ name: 'bananas', quantity: null });
    expect(parseGroceryItem('2% milk')).toEqual({ name: '2% milk', quantity: null });
  });
});

describe('suggestKind', () => {
  it('detects shopping intent', () => {
    expect(suggestKind('Buy milk', NOW)).toBe('shopping');
    expect(suggestKind('buy milk tomorrow', NOW)).toBe('shopping'); // shopping beats the trailing day
    expect(suggestKind('pick up dry cleaning', NOW)).toBe('shopping');
    expect(suggestKind('grab coffee filters', NOW)).toBe('shopping');
    expect(suggestKind('add eggs to the grocery list', NOW)).toBe('shopping');
  });

  it('detects events from a date/time', () => {
    expect(suggestKind('Dentist at 3pm tomorrow', NOW)).toBe('event');
    expect(suggestKind('Soccer monday', NOW)).toBe('event');
    expect(suggestKind('pick up kids at 3pm', NOW)).toBe('event'); // time wins over soft "pick up"
  });

  it('detects notes', () => {
    expect(suggestKind('Note: the wifi password is on the fridge', NOW)).toBe('note');
    expect(suggestKind('a'.repeat(90), NOW)).toBe('note');
  });

  it('defaults to task', () => {
    expect(suggestKind('Call the plumber', NOW)).toBe('task');
    expect(suggestKind('Finish the report', NOW)).toBe('task');
    expect(suggestKind('', NOW)).toBe('task');
  });
});
