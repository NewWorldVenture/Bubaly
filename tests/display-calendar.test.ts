import { describe, expect, it } from 'vitest';
import { displayCalendarWindow, displayDayKey, displayEventDays, displayReminderTime, eventOverlapsWindow, familyDisplayCalendar } from '@/lib/display/calendar';
import { buildHints, countdownLabel, dayPart, formatClock, nowAndNext } from '@/lib/display/ambient';

describe('family display calendar', () => {
  it.each([
    ['America/Los_Angeles', '2026-09-12T02:00:00Z', '2026-09-11'],
    ['Pacific/Auckland', '2026-12-31T12:00:00Z', '2027-01-01'],
    ['Pacific/Honolulu', '2027-01-01T02:00:00Z', '2026-12-31'],
  ])('resolves the family date in %s', (zone, now, date) => {
    const calendar = familyDisplayCalendar(new Date(now), zone);
    expect(calendar.dayKey).toBe(date);
    expect(calendar.timezoneFallback).toBe(false);
    expect(calendar.today).toBe(Number(date.slice(8)));
    expect(calendar.month).toBe(Number(date.slice(5, 7)) - 1);
    expect(calendar.year).toBe(Number(date.slice(0, 4)));
  });

  it.each([
    ['America/New_York', '2026-03-08', '2026-03-09', '2026-03-08T05:00:00.000Z', '2026-03-09T04:00:00.000Z', 23],
    ['America/New_York', '2026-11-01', '2026-11-02', '2026-11-01T04:00:00.000Z', '2026-11-02T05:00:00.000Z', 25],
    ['America/Sao_Paulo', '2018-11-04', '2018-11-05', '2018-11-04T03:00:00.000Z', '2018-11-05T02:00:00.000Z', 23],
    ['Pacific/Apia', '2011-12-30', '2011-12-31', '2011-12-30T10:00:00.000Z', '2011-12-30T10:00:00.000Z', 0],
  ])('keeps civil-day bounds across %s %s', (zone, start, end, expectedStart, expectedEnd, hours) => {
    const window = displayCalendarWindow(start, end, zone);
    expect(window.start.toISOString()).toBe(expectedStart);
    expect(window.end.toISOString()).toBe(expectedEnd);
    expect((window.end.getTime() - window.start.getTime()) / 3_600_000).toBe(hours);
  });

  it('discloses UTC fallback and never invents a date for an invalid clock', () => {
    expect(familyDisplayCalendar(new Date('2026-09-12T02:00:00Z'), 'bad/zone')).toMatchObject({ timezone: 'UTC', timezoneFallback: true, dayKey: '2026-09-12' });
    expect(familyDisplayCalendar(new Date('2026-09-12T02:00:00Z'), null).timezoneFallback).toBe(true);
    expect(displayDayKey(new Date(NaN), 'UTC')).toBeNull();
    expect(() => familyDisplayCalendar(new Date(NaN), 'UTC')).toThrow('Invalid display clock');
    expect(() => displayCalendarWindow('2026-02-30', '2026-03-02', 'UTC')).toThrow();
  });

  it('uses half-open timed overlaps and only the recorded start for unknown duration', () => {
    const window = displayCalendarWindow('2026-09-12', '2026-09-13', 'UTC');
    expect(eventOverlapsWindow({ starts_at: '2026-09-11T23:00:00Z', ends_at: '2026-09-12T02:00:00Z' }, window)).toBe(true);
    expect(eventOverlapsWindow({ starts_at: '2026-09-11T23:00:00Z', ends_at: '2026-09-12T00:00:00Z' }, window)).toBe(false);
    expect(eventOverlapsWindow({ starts_at: '2026-09-13T00:00:00Z', ends_at: '2026-09-13T01:00:00Z' }, window)).toBe(false);
    expect(eventOverlapsWindow({ starts_at: '2026-09-11T23:00:00Z' }, window)).toBe(false);
    expect(eventOverlapsWindow({ starts_at: '2026-09-12T09:00:00Z', ends_at: 'bad-date' }, window)).toBe(true);
    expect(eventOverlapsWindow({ starts_at: 'bad-date', all_day: true }, window)).toBe(false);
  });

  it('marks full all-day date spans with exclusive ends without shifting them into the family zone', () => {
    const month = displayCalendarWindow('2026-09-01', '2026-10-01', 'America/Los_Angeles');
    expect(displayEventDays([{ starts_at: '2026-09-11T00:00:00Z', ends_at: '2026-09-13T00:00:00Z', all_day: true }], month, 'America/Los_Angeles')).toEqual([11, 12]);
    expect(displayEventDays([{ starts_at: '2026-09-12T01:00:00Z', ends_at: '2026-09-12T02:00:00Z' }], month, 'America/Los_Angeles')).toEqual([11]);
  });

  it('distinguishes a skipped calendar date from timed occupancy', () => {
    const window = displayCalendarWindow('2011-12-30', '2011-12-31', 'Pacific/Apia');
    expect(eventOverlapsWindow({ starts_at: '2011-12-29T00:00:00Z', ends_at: '2012-01-01T00:00:00Z' }, window)).toBe(false);
    expect(eventOverlapsWindow({ starts_at: '2011-12-30T00:00:00Z', all_day: true }, window)).toBe(true);
  });
});

describe('timed availability and family clock', () => {
  const now = new Date('2026-09-12T09:00:00Z');
  const event = (start: string, end?: string | null, allDay = false) => ({ id: start, title: 'Event', starts_at: `2026-09-12T${start}Z`, ends_at: end === undefined || end === null ? end : `2026-09-12T${end}Z`, all_day: allDay });
  it('uses real ends, including long events and exact end exclusion', () => {
    expect(nowAndNext([event('06:00:00', '10:00:00')], now).current).not.toBeNull();
    expect(nowAndNext([event('08:30:00', '08:45:00')], now).current).toBeNull();
    expect(nowAndNext([event('08:30:00', '09:00:00')], now).current).toBeNull();
    expect(nowAndNext([event('09:00:00', '10:00:00')], now).current).not.toBeNull();
  });
  it.each([undefined, null, 'invalid', '08:00:00'])('never claims current for an unknown/invalid end %s', end => {
    expect(nowAndNext([event('08:30:00', end)], now).current).toBeNull();
  });
  it('excludes all-day events from both current and next and safely handles invalid dates', () => {
    expect(nowAndNext([event('00:00:00', '23:59:00', true), event('10:00:00', '12:00:00', true)], now)).toEqual({ current: null, next: null });
    expect(nowAndNext([{ id: 'bad', title: 'Bad', starts_at: 'invalid' }], now)).toEqual({ current: null, next: null });
    expect(nowAndNext([event('10:00:00')], new Date(NaN))).toEqual({ current: null, next: null });
    expect(nowAndNext([event('10:00:00')], now).next).not.toBeNull();
  });
  it('formats family clock/day part/countdown and suppresses unread availability claims', () => {
    const late = new Date('2026-09-12T02:00:00Z');
    expect(formatClock(late, { clock24: true, seconds: false, timezone: 'America/Los_Angeles' }).time).toBe('19:00');
    expect(dayPart(late, 'America/Los_Angeles')).toBe('evening');
    expect(countdownLabel('2026-09-12T04:00:00Z', late, 'America/Los_Angeles')).toBe('9:00 PM');
    expect(countdownLabel('2026-09-12T01:45:00Z', late, 'America/Los_Angeles')).not.toBe('Now');
    expect(buildHints({ availabilityKnown: false }, late, 'America/Los_Angeles').join(' ')).not.toMatch(/All clear/);
    expect(buildHints({ availabilityKnown: false, nextEvent: { title: 'Verified calendar', startsAt: '2026-09-12T04:00:00Z' } }, late, 'America/Los_Angeles').join(' ')).toContain('Verified calendar');
  });
  it('uses snooze as a lower bound and keeps missing dates unknown', () => {
    expect(displayReminderTime({ status: 'snoozed', remind_at: '2026-09-12T09:00:00Z', snoozed_until: '2026-09-12T10:00:00Z' })).toBe('2026-09-12T10:00:00.000Z');
    expect(displayReminderTime({ status: 'snoozed', remind_at: '2026-09-12T09:00:00Z', snoozed_until: '2026-09-12T08:00:00Z' })).toBe('2026-09-12T09:00:00.000Z');
    expect(displayReminderTime({ status: 'active', remind_at: null })).toBeNull();
  });
});
