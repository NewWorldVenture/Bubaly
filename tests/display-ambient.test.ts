import { describe, it, expect } from 'vitest';
import {
  dayPartForHour, dayPart, greeting, ambientTheme, THEME_OPTIONS,
  normalizeSettings, DEFAULT_DISPLAY_SETTINGS, formatClock, formatTemp, tempFromFahrenheit,
  nowAndNext, countdownLabel, formatDuration, buildHints, TIMER_PRESETS, IDLE_OPTIONS,
  type TimedEvent,
} from '@/lib/display/ambient';

describe('dayPart', () => {
  it('maps hours to the right part', () => {
    expect(dayPartForHour(6)).toBe('dawn');
    expect(dayPartForHour(9)).toBe('morning');
    expect(dayPartForHour(14)).toBe('afternoon');
    expect(dayPartForHour(19)).toBe('evening');
    expect(dayPartForHour(23)).toBe('night');
    expect(dayPartForHour(2)).toBe('night');
  });
  it('handles boundaries and wraps', () => {
    expect(dayPartForHour(5)).toBe('dawn');
    expect(dayPartForHour(7)).toBe('morning');
    expect(dayPartForHour(12)).toBe('afternoon');
    expect(dayPartForHour(17)).toBe('evening');
    expect(dayPartForHour(21)).toBe('night');
    expect(dayPartForHour(24)).toBe('night'); // wraps to 0
    expect(dayPartForHour(-1)).toBe('night'); // wraps to 23
  });
  it('reads the hour off a Date', () => {
    const d = new Date('2026-07-14T09:30:00');
    expect(dayPart(d)).toBe('morning');
  });
});

describe('greeting', () => {
  it('picks the day-part phrase and appends a name', () => {
    expect(greeting('morning')).toBe('Good morning');
    expect(greeting('afternoon', 'The Hughen Family')).toBe('Good afternoon, The Hughen Family');
    expect(greeting('evening', '  ')).toBe('Good evening');
    expect(greeting('night', null)).toBe('Good night');
  });
});

describe('ambientTheme', () => {
  it('auto follows the clock', () => {
    expect(ambientTheme('auto', new Date('2026-07-14T19:00:00')).name).toBe('Evening');
    expect(ambientTheme('auto', new Date('2026-07-14T09:00:00')).name).toBe('Morning');
  });
  it('explicit theme ignores the clock', () => {
    expect(ambientTheme('sunset', new Date('2026-07-14T09:00:00')).name).toBe('Sunset');
    expect(ambientTheme('midnight', new Date('2026-07-14T12:00:00')).name).toBe('Midnight');
  });
  it('every option resolves to a gradient', () => {
    for (const t of THEME_OPTIONS) {
      const theme = ambientTheme(t, new Date('2026-07-14T12:00:00'));
      expect(theme.gradient).toMatch(/gradient/);
      expect(theme.glow).toMatch(/^#/);
    }
  });
});

describe('normalizeSettings', () => {
  it('returns defaults for junk', () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_DISPLAY_SETTINGS);
    expect(normalizeSettings('nope')).toEqual(DEFAULT_DISPLAY_SETTINGS);
    expect(normalizeSettings({})).toEqual(DEFAULT_DISPLAY_SETTINGS);
  });
  it('keeps valid fields and drops invalid ones', () => {
    const s = normalizeSettings({ clock24: true, tempUnit: 'C', theme: 'aurora', ambient: false, seconds: true, screensaver: false, background: 'photos', idleMinutes: 10, bogus: 1 });
    expect(s).toEqual({ clock24: true, seconds: true, tempUnit: 'C', theme: 'aurora', ambient: false, screensaver: false, background: 'photos', idleMinutes: 10 });
  });
  it('coerces invalid enums to defaults', () => {
    const s = normalizeSettings({ tempUnit: 'K', theme: 'rainbow', background: 'video', idleMinutes: 7 });
    expect(s.tempUnit).toBe('F');
    expect(s.theme).toBe('auto');
    expect(s.background).toBe('gradient');
    expect(s.idleMinutes).toBe(DEFAULT_DISPLAY_SETTINGS.idleMinutes);
  });
  it('idleMinutes accepts every published option including off', () => {
    for (const v of IDLE_OPTIONS) expect(normalizeSettings({ idleMinutes: v }).idleMinutes).toBe(v);
  });
});

describe('formatClock', () => {
  const noon = new Date('2026-07-14T12:05:09');
  const morning = new Date('2026-07-14T09:07:03');
  const midnight = new Date('2026-07-14T00:00:00');
  it('12-hour with suffix', () => {
    expect(formatClock(noon, { clock24: false, seconds: false })).toEqual({ time: '12:05', suffix: 'PM' });
    expect(formatClock(morning, { clock24: false, seconds: false })).toEqual({ time: '9:07', suffix: 'AM' });
    expect(formatClock(midnight, { clock24: false, seconds: false })).toEqual({ time: '12:00', suffix: 'AM' });
  });
  it('24-hour has no suffix and zero-pads', () => {
    expect(formatClock(morning, { clock24: true, seconds: false })).toEqual({ time: '09:07', suffix: '' });
    expect(formatClock(midnight, { clock24: true, seconds: false })).toEqual({ time: '00:00', suffix: '' });
  });
  it('optional seconds', () => {
    expect(formatClock(noon, { clock24: true, seconds: true }).time).toBe('12:05:09');
    expect(formatClock(morning, { clock24: false, seconds: true }).time).toBe('9:07:03');
  });
});

describe('formatTemp', () => {
  it('converts C to F and rounds', () => {
    expect(formatTemp(0, 'F')).toBe('32°');
    expect(formatTemp(20, 'F')).toBe('68°');
    expect(formatTemp(20, 'C')).toBe('20°');
    expect(formatTemp(21.6, 'C')).toBe('22°');
  });
});

describe('tempFromFahrenheit', () => {
  it('keeps F and converts to C', () => {
    expect(tempFromFahrenheit(68, 'F')).toBe('68°');
    expect(tempFromFahrenheit(32, 'C')).toBe('0°');
    expect(tempFromFahrenheit(212, 'C')).toBe('100°');
    expect(tempFromFahrenheit(70, 'C')).toBe('21°');
  });
});

describe('nowAndNext', () => {
  const base = '2026-07-14T';
  const events: TimedEvent[] = [
    { id: 'a', title: 'Breakfast', starts_at: `${base}08:00:00` },
    { id: 'b', title: 'Dentist', starts_at: `${base}10:00:00` },
    { id: 'c', title: 'Piano', starts_at: `${base}13:00:00` },
    { id: 'd', title: 'All-day fair', starts_at: `${base}00:00:00`, all_day: true },
  ];
  it('finds the current (recent, within window) and next event', () => {
    const now = new Date(`${base}10:20:00`);
    const { current, next } = nowAndNext(events, now, 90);
    expect(current?.id).toBe('b'); // dentist started 20 min ago
    expect(next?.id).toBe('c');    // piano is up next
  });
  it('drops a current event once it is outside the window', () => {
    const now = new Date(`${base}12:00:00`);
    const { current, next } = nowAndNext(events, now, 90);
    expect(current).toBeNull();  // dentist was 2h ago
    expect(next?.id).toBe('c');
  });
  it('ignores all-day events as "current"', () => {
    const now = new Date(`${base}00:30:00`);
    expect(nowAndNext(events, now, 90).current).toBeNull();
  });
  it('next is null when nothing remains', () => {
    const now = new Date(`${base}23:00:00`);
    expect(nowAndNext(events, now).next).toBeNull();
  });
});

describe('countdownLabel', () => {
  const now = new Date('2026-07-14T10:00:00');
  it('"Now" for in-progress / just-started', () => {
    expect(countdownLabel('2026-07-14T10:00:00', now)).toBe('Now');
    expect(countdownLabel('2026-07-14T09:30:00', now)).toBe('Now');
  });
  it('minutes for soon', () => {
    expect(countdownLabel('2026-07-14T10:25:00', now)).toBe('in 25 min');
  });
  it('clock time later today', () => {
    expect(countdownLabel('2026-07-14T14:00:00', now)).toMatch(/2:00/);
  });
  it('weekday + time for another day', () => {
    expect(countdownLabel('2026-07-16T14:00:00', now)).toMatch(/Thu/);
  });
  it('empty for junk', () => {
    expect(countdownLabel('not-a-date', now)).toBe('');
  });
});

describe('formatDuration', () => {
  it('renders m:ss under an hour', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(42)).toBe('0:42');
    expect(formatDuration(6 * 60)).toBe('6:00');
    expect(formatDuration(599)).toBe('9:59');
  });
  it('renders h:mm:ss over an hour and clamps negatives', () => {
    expect(formatDuration(3723)).toBe('1:02:03');
    expect(formatDuration(-5)).toBe('0:00');
  });
});

describe('TIMER_PRESETS', () => {
  it('are all positive and labeled', () => {
    for (const p of TIMER_PRESETS) {
      expect(p.seconds).toBeGreaterThan(0);
      expect(p.label.length).toBeGreaterThan(0);
    }
  });
});

describe('buildHints', () => {
  const now = new Date('2026-07-14T10:00:00');
  it('orders next event, dinner, chores, groceries, birthdays, reminders', () => {
    const hints = buildHints({
      nextEvent: { title: 'Piano lesson', startsAt: '2026-07-14T13:00:00' },
      dinner: 'Chicken Tacos',
      groceryCount: 12,
      choresDue: 3,
      birthdays: [{ name: 'Sarah', date: 'Jul 20' }],
      remindersDue: 2,
    }, now);
    expect(hints[0]).toContain('Piano lesson');
    expect(hints[1]).toContain('Chicken Tacos');
    expect(hints[2]).toContain('3 chores');
    expect(hints[3]).toContain('12 items');
    expect(hints[4]).toContain("Sarah's birthday");
    expect(hints[5]).toContain('2 reminders');
  });
  it('singularizes counts of one', () => {
    const hints = buildHints({ groceryCount: 1, choresDue: 1, remindersDue: 1 }, now).join(' ');
    expect(hints).toContain('1 chore due');
    expect(hints).toContain('1 item on');
    expect(hints).toContain('1 reminder coming');
  });
  it('falls back to evergreen tips when there is nothing to say', () => {
    expect(buildHints({}, now).length).toBeGreaterThanOrEqual(3);
  });
});
