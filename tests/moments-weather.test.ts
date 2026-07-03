import { describe, it, expect } from 'vitest';
import { weatherAdvisory, dayKey, type DayWx } from '@/lib/moments/weather';

const wx = (o: Partial<DayWx>): DayWx => ({ tempMax: 70, tempMin: 55, precipProb: 10, code: 0, ...o });

describe('weatherAdvisory', () => {
  it('flags rain by high precip probability, with the percentage', () => {
    expect(weatherAdvisory(wx({ precipProb: 80 }))?.label).toBe('Rain likely (80%) — pack umbrellas');
  });
  it('flags rain by weather code even when precip prob is missing', () => {
    expect(weatherAdvisory(wx({ precipProb: null, code: 63 }))?.label).toContain('Rain likely');
  });
  it('flags snow, storms, cold, and heat', () => {
    expect(weatherAdvisory(wx({ code: 73 }))?.label).toContain('Snow');
    expect(weatherAdvisory(wx({ code: 95 }))?.label).toContain('Storms');
    expect(weatherAdvisory(wx({ tempMax: 32 }))?.label).toContain('Cold');
    expect(weatherAdvisory(wx({ tempMax: 92 }))?.label).toContain('Hot');
  });
  it('returns null for a mild, clear day', () => {
    expect(weatherAdvisory(wx({ tempMax: 72, precipProb: 10, code: 1 }))).toBeNull();
  });
  it('prioritizes snow over rain/cold', () => {
    expect(weatherAdvisory(wx({ code: 75, precipProb: 90, tempMax: 30 }))?.label).toContain('Snow');
  });
});

describe('dayKey', () => {
  it('formats a local YYYY-MM-DD and rejects junk', () => {
    expect(dayKey('2026-07-04T15:00:00')).toBe('2026-07-04');
    expect(dayKey('nope')).toBe('');
  });
});
