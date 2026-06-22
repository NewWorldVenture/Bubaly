import { describe, it, expect } from 'vitest';
import {
  haversineMeters, placeForPoint, classifyTransition, timeAgo, distanceLabel, isStale,
  type PlaceLike,
} from '@/lib/location/geo';

describe('haversineMeters', () => {
  it('is ~0 for identical points', () => {
    expect(haversineMeters({ latitude: 40, longitude: -74 }, { latitude: 40, longitude: -74 })).toBeCloseTo(0, 5);
  });
  it('matches a known distance (~111 km per degree latitude)', () => {
    const d = haversineMeters({ latitude: 40, longitude: -74 }, { latitude: 41, longitude: -74 });
    expect(d).toBeGreaterThan(110_000);
    expect(d).toBeLessThan(112_000);
  });
});

describe('placeForPoint', () => {
  const places: PlaceLike[] = [
    { id: 'home', name: 'Home', latitude: 40.0000, longitude: -74.0000, radius_m: 150 },
    { id: 'school', name: 'School', latitude: 40.0100, longitude: -74.0000, radius_m: 150 },
  ];
  it('returns the place whose geofence contains the point', () => {
    expect(placeForPoint(places, { latitude: 40.0005, longitude: -74.0000 })!.id).toBe('home');
  });
  it('returns null when outside every geofence', () => {
    expect(placeForPoint(places, { latitude: 40.5000, longitude: -74.0000 })).toBeNull();
  });
  it('picks the closest when geofences overlap', () => {
    const overlap: PlaceLike[] = [
      { id: 'a', name: 'A', latitude: 40, longitude: -74, radius_m: 5000 },
      { id: 'b', name: 'B', latitude: 40.001, longitude: -74, radius_m: 5000 },
    ];
    expect(placeForPoint(overlap, { latitude: 40.0009, longitude: -74 })!.id).toBe('b');
  });
});

describe('classifyTransition', () => {
  it('classifies arrive/leave/move/none', () => {
    expect(classifyTransition(null, null)).toBe('none');
    expect(classifyTransition('home', 'home')).toBe('none');
    expect(classifyTransition(null, 'home')).toBe('arrived');
    expect(classifyTransition('home', null)).toBe('left');
    expect(classifyTransition('home', 'school')).toBe('moved');
  });
});

describe('timeAgo', () => {
  const now = new Date('2026-06-22T12:00:00Z');
  it('formats minutes/hours/days', () => {
    expect(timeAgo('2026-06-22T11:59:40Z', now)).toBe('just now');
    expect(timeAgo('2026-06-22T11:30:00Z', now)).toBe('30m ago');
    expect(timeAgo('2026-06-22T09:00:00Z', now)).toBe('3h ago');
    expect(timeAgo('2026-06-20T12:00:00Z', now)).toBe('2d ago');
  });
});

describe('distanceLabel', () => {
  it('uses metres under 1 km, km above', () => {
    expect(distanceLabel(250)).toBe('250 m');
    expect(distanceLabel(1500)).toBe('1.5 km');
  });
});

describe('isStale', () => {
  const now = new Date('2026-06-22T12:00:00Z');
  it('flags locations older than the threshold', () => {
    expect(isStale('2026-06-22T11:55:00Z', now, 30)).toBe(false);
    expect(isStale('2026-06-22T11:00:00Z', now, 30)).toBe(true);
  });
});
