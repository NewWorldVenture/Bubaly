import { describe, it, expect } from 'vitest';
import { parseEvent } from '@/lib/capture/parse';

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
