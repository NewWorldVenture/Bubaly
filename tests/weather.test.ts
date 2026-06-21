import { describe, expect, it } from 'vitest';
import { weatherInfo } from '@/lib/weather/open-meteo';

describe('weatherInfo (WMO code mapping)', () => {
  it('maps known codes to a label + icon', () => {
    expect(weatherInfo(0).label).toBe('Clear');
    expect(weatherInfo(3).label).toBe('Overcast');
    expect(weatherInfo(95).label).toBe('Thunderstorm');
    expect(weatherInfo(0).icon.length).toBeGreaterThan(0);
  });

  it('uses a night icon for clear sky when not day', () => {
    expect(weatherInfo(0, true).icon).toBe('☀️');
    expect(weatherInfo(0, false).icon).toBe('🌙');
  });

  it('falls back gracefully for unknown codes', () => {
    expect(weatherInfo(1234).label).toBe('Unknown');
    expect(weatherInfo(1234).icon).toBe('🌡️');
  });
});
