import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ComponentProps } from 'react';
import { renderToString } from 'react-dom/server';
import { FamilyTimeZoneProvider, LocaleProvider } from '@/components/i18n/locale-provider';
import { calendarDayOfKey, useFamilyClock, type FamilyClock } from '@/components/i18n/use-format';
import { localeOrDefault } from '@/lib/i18n/locales';

// A DATE-only handoff is a device-local calendar Date, not a wall reading or
// an instant. Use its local fields; the helper's calendar overflow remains
// unchanged. These native Date and real React-provider checks do not claim
// browser hydration, provider, authorization, API or production acceptance.
const supportedDays = ['0001-01-01', '0004-02-29', '0099-12-31', '0100-03-01', '0400-02-29', '2026-10-09', '9999-12-31'];
const parts = (date: Date) => [date.getFullYear(), date.getMonth() + 1, date.getDate()];
const expectedParts = (day: string) => day.split('-').map(Number);

function clockFor(timeZone: string): FamilyClock {
  let clock: FamilyClock | undefined;
  const Probe = () => { clock = useFamilyClock(); return null; };
  renderToString(createElement(LocaleProvider, {
    locale: localeOrDefault('en-US'), source: 'default', messages: {},
  } as ComponentProps<typeof LocaleProvider>,
  createElement(FamilyTimeZoneProvider, { timeZone } as ComponentProps<typeof FamilyTimeZoneProvider>, createElement(Probe))));
  if (!clock) throw new Error('The actual provider did not produce a family clock');
  return clock;
}

afterEach(() => vi.restoreAllMocks());

describe('the DATE-only constructor keeps supported Gregorian years', () => {
  it.each(supportedDays)('%s retains its local calendar fields', day => {
    expect(parts(calendarDayOfKey(day))).toEqual(expectedParts(day));
  });

  it.each([
    ['0001-12-32', [2, 1, 1]],
    ['0004-02-30', [4, 3, 1]],
    ['0099-13-01', [100, 1, 1]],
    ['0100-02-29', [100, 3, 1]],
    ['0400-02-30', [400, 3, 1]],
    ['2026-02-30', [2026, 3, 2]],
    ['2026-00-00', [2025, 11, 30]],
    ['9999-12-00', [9999, 11, 30]],
    ['9999-13-01', [10000, 1, 1]],
  ] as const)('%s keeps the existing constructor calendar overflow', (key, expected) => {
    // Public DATE admission is validated separately. An internal constructor
    // rollover must not silently return a different century or adopt a new
    // strict-date policy here.
    expect(parts(calendarDayOfKey(key))).toEqual(expected);
  });

  it.each(['bad', '', '2026-01', '2026/01/01', '2026-01-notday', 'Infinity-01-01'])('%s remains unparseable', key => {
    expect(Number.isNaN(calendarDayOfKey(key).getTime())).toBe(true);
  });

  it.each(['0000-01-01', '10000-01-01', '-000001-01-01', '1.5-01-01', '0-00-00'])('%s retains its unsupported or legacy constructor result', key => {
    // Preserve the prior result without admitting this input as a supported
    // public day or changing the existing invalid-input policy.
    const [year, month, day] = key.split('-').map(Number);
    expect(calendarDayOfKey(key).getTime()).toBe(new Date(year, month - 1, day).getTime());
  });
});

describe('the actual family clock hands off the family date unchanged', () => {
  it.each(supportedDays)('%s stays the same through the React-provider DATE handoff', day => {
    const now = new Date(day + 'T12:30:00Z');
    const clock = clockFor('UTC');
    expect(clock.todayKey(now)).toBe(day);
    expect(clock.wallKey(clock.wallNow(now))).toBe(day);
    expect(parts(clock.calendarToday(now))).toEqual(expectedParts(day));
  });

  it.each([
    ['America/Los_Angeles', '2026-10-09T01:30:00Z', '2026-10-08'],
    ['Asia/Tokyo', '2026-10-09T23:30:00Z', '2026-10-10'],
    ['America/Santiago', '2026-09-06T15:00:00Z', '2026-09-06'],
  ])('%s hands off its own day rather than the UTC day', (zone, instant, day) => {
    const clock = clockFor(zone);
    const now = new Date(instant);
    expect(clock.todayKey(now)).toBe(day);
    expect(clock.wallKey(clock.wallNow(now))).toBe(day);
    expect(parts(clock.calendarToday(now))).toEqual(expectedParts(day));
  });

  it('uses the supplied AD1 clock without reading Date.now', () => {
    const clock = clockFor('UTC');
    const now = new Date('0001-01-01T12:30:00Z');
    const read = vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('Unexpected ambient clock read'); });
    expect(parts(clock.calendarToday(now))).toEqual([1, 1, 1]);
    expect(read).not.toHaveBeenCalled();
  });
});
