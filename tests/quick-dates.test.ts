import { describe, it, expect } from 'vitest';
import {
  toLocalDate,
  toLocalDateTimeInput,
  QUICK_DATE_PRESETS,
  QUICK_TIME_PRESETS,
} from '@/lib/utils/quick-dates';

describe('toLocalDate', () => {
  it('formats a date as YYYY-MM-DD in local time with zero-padding', () => {
    // Constructed with local Y/M/D so there is no timezone ambiguity.
    expect(toLocalDate(new Date(2026, 0, 5))).toBe('2026-01-05');
    expect(toLocalDate(new Date(2026, 11, 31))).toBe('2026-12-31');
  });
});

describe('toLocalDateTimeInput', () => {
  it('formats as YYYY-MM-DDTHH:mm in local time', () => {
    expect(toLocalDateTimeInput(new Date(2026, 2, 9, 7, 4))).toBe('2026-03-09T07:04');
    expect(toLocalDateTimeInput(new Date(2026, 2, 9, 18, 30))).toBe('2026-03-09T18:30');
  });
});

describe('QUICK_DATE_PRESETS', () => {
  it('Today resolves to today and Tomorrow to the next day', () => {
    const byLabel = Object.fromEntries(QUICK_DATE_PRESETS.map((p) => [p.label, p]));
    const today = new Date();
    expect(toLocalDate(byLabel['Today'].compute())).toBe(toLocalDate(today));
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    expect(toLocalDate(byLabel['Tomorrow'].compute())).toBe(toLocalDate(tomorrow));
  });

  it('This weekend lands on a Saturday in the future', () => {
    const sat = QUICK_DATE_PRESETS.find((p) => p.label === 'This weekend')!.compute();
    expect(sat.getDay()).toBe(6);
    expect(sat.getTime()).toBeGreaterThanOrEqual(Date.now() - 1000);
  });

  it('Next week lands on a Monday strictly in the future', () => {
    const mon = QUICK_DATE_PRESETS.find((p) => p.label === 'Next week')!.compute();
    expect(mon.getDay()).toBe(1);
    expect(mon.getTime()).toBeGreaterThan(Date.now());
  });
});

describe('QUICK_TIME_PRESETS', () => {
  it('all presets resolve to a time in the future', () => {
    for (const p of QUICK_TIME_PRESETS) {
      expect(p.compute().getTime()).toBeGreaterThan(Date.now() - 1000);
    }
  });

  it('Tomorrow 9am is the next day at 09:00 local', () => {
    const d = QUICK_TIME_PRESETS.find((p) => p.label === 'Tomorrow 9am')!.compute();
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(0);
  });
});
