import { describe, expect, it } from 'vitest';
import { dayKey, dayLabel, nextDayKey, nextFamilyDayDelay } from '../mobile/src/lib/format';

describe('native family calendar date boundaries', () => {
  it.each(['0001-01-01', '0009-12-31', '0096-02-29', '0099-12-31', '0100-01-01'])('keeps four-digit Gregorian family DATE %s', day => {
    expect(dayKey(new Date(`${day}T12:00:00Z`), 'UTC')).toBe(day);
  });
  it('pads the existing device-local fallback for a Gregorian year below 100', () => {
    const local = new Date('0099-12-31T12:00:00Z');
    const expected = `${String(local.getFullYear()).padStart(4, '0')}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`;
    expect(dayKey(local, 'Invalid/Zone')).toBe(expected);
  });
  it('labels tomorrow across Gregorian 0099 to 0100', () => {
    expect(dayLabel(new Date('0100-01-01T12:00:00Z'), 'UTC', new Date('0099-12-31T23:30:00Z'))).toBe('Tomorrow');
    expect(nextDayKey('0099-12-31')).toBe('0100-01-01');
  });
  it.each([
    ['2026-11-01T04:30:00Z', '2026-11-02T17:00:00Z', 'Tomorrow'],
    ['2026-03-08T04:30:00Z', '2026-03-08T16:00:00Z', 'Tomorrow'],
    ['2026-03-08T04:30:00Z', '2026-03-09T16:00:00Z', 'Mon, Mar 9'],
  ])('labels civil tomorrow through New York DST from %s', (now, event, expected) => {
    expect(dayLabel(new Date(event), 'America/New_York', new Date(now))).toBe(expected);
  });

  it.each([
    ['2024-02-28', '2024-02-29'], ['2024-02-29', '2024-03-01'],
    ['2026-12-31', '2027-01-01'], ['2026-01-31', '2026-02-01'],
  ])('advances Gregorian date %s without an elapsed-time zone', (day, expected) => {
    expect(nextDayKey(day)).toBe(expected);
  });

  it.each([
    ['UTC', '0099-12-31T23:30:00Z', '0100-01-01T00:00:00Z'],
    ['UTC', '0001-01-01T23:59:00Z', '0001-01-02T00:00:00Z'],
    ['America/New_York', '2026-11-01T04:30:00Z', '2026-11-02T05:00:00Z'],
    ['America/New_York', '2026-03-08T05:30:00Z', '2026-03-09T04:00:00Z'],
    ['America/Los_Angeles', '2026-10-10T23:59:00Z', '2026-10-11T07:00:00Z'],
    ['Asia/Kathmandu', '2026-10-10T18:14:59Z', '2026-10-10T18:15:00Z'],
    ['America/Sao_Paulo', '2018-11-04T02:30:00Z', '2018-11-04T03:00:00Z'],
    ['Pacific/Apia', '2011-12-30T09:30:00Z', '2011-12-30T10:00:00Z'],
  ])('schedules the actual next date in %s at %s', (zone, now, expected) => {
    const start = new Date(now);
    const delay = nextFamilyDayDelay(start, zone);
    const boundary = new Date(start.getTime() + delay);
    expect(boundary.toISOString()).toBe(new Date(expected).toISOString());
    expect(delay).toBeGreaterThan(0); expect(delay).toBeLessThanOrEqual(3 * 86_400_000);
    expect(dayKey(new Date(boundary.getTime() - 1), zone)).toBe(dayKey(start, zone));
    expect(dayKey(boundary, zone)).not.toBe(dayKey(start, zone));
  });

  it('refuses an invalid scheduler zone rather than adopting the device zone', () => {
    expect(() => nextFamilyDayDelay(new Date('2026-10-10T12:00:00Z'), 'Invalid/Zone')).toThrow();
  });
});
