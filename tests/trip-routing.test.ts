import { describe, it, expect } from 'vitest';
import {
  parseOsrmDuration, parseOsrmDistance, metersToMiles, fallbackDriveSeconds, haversineMiles,
} from '@/lib/trips/routing';

describe('parseOsrmDuration / parseOsrmDistance', () => {
  const ok = { code: 'Ok', routes: [{ duration: 1234.7, distance: 8050 }] };
  it('parses a valid OSRM response', () => {
    expect(parseOsrmDuration(ok)).toBe(1235);
    expect(parseOsrmDistance(ok)).toBe(8050);
  });
  it('returns null for errors / empty routes', () => {
    expect(parseOsrmDuration({ code: 'NoRoute', routes: [] })).toBeNull();
    expect(parseOsrmDuration(null)).toBeNull();
    expect(parseOsrmDuration({ code: 'Ok', routes: [] })).toBeNull();
    expect(parseOsrmDistance({ code: 'Ok' })).toBeNull();
  });
});

describe('metersToMiles', () => {
  it('converts and rounds', () => {
    expect(metersToMiles(1609.34)).toBe(1);
    expect(metersToMiles(null)).toBeNull();
  });
});

describe('fallbackDriveSeconds', () => {
  it('estimates by average speed', () => {
    expect(fallbackDriveSeconds(30, 30)).toBe(3600); // 30 mi @ 30mph = 1h
    expect(fallbackDriveSeconds(0)).toBe(0);
  });
  it('guards a too-low speed', () => {
    expect(fallbackDriveSeconds(10, 1)).toBe(fallbackDriveSeconds(10, 5));
  });
});

describe('haversineMiles', () => {
  it('is ~0 for the same point', () => {
    expect(haversineMiles({ lat: 32, lng: -81 }, { lat: 32, lng: -81 })).toBe(0);
  });
  it('approximates a known distance (Savannah ↔ Atlanta ≈ 215mi)', () => {
    const d = haversineMiles({ lat: 32.0809, lng: -81.0912 }, { lat: 33.749, lng: -84.388 });
    expect(d).toBeGreaterThan(200);
    expect(d).toBeLessThan(230);
  });
});
