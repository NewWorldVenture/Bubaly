// lib/trips/routing.ts — real driving time + geocoding for Smart Departure.
//
// Uses OSRM's free public demo server (no API key) for door-to-door driving
// duration, and reuses Open-Meteo geocoding (also keyless). Every request runs
// in the browser, so it works regardless of server network policy and never
// needs a secret — mirroring lib/weather/open-meteo.ts.

import { readBoundedResponseJson } from '@/lib/server/bounded-response-body';
import { fetchWithTimeout } from '@/lib/client-fetch';

export type LatLng = { lat: number; lng: number };

/** Pure parser for an OSRM /route response → driving seconds (or null). */
export function parseOsrmDuration(json: unknown): number | null {
  if (!json || typeof json !== 'object') return null;
  const j = json as { code?: string; routes?: Array<{ duration?: number }> };
  if (j.code !== 'Ok' || !Array.isArray(j.routes) || j.routes.length === 0) return null;
  const dur = j.routes[0]?.duration;
  return typeof dur === 'number' && Number.isFinite(dur) ? Math.round(dur) : null;
}

/** Pure parser for an OSRM /route response → driving meters (or null). */
export function parseOsrmDistance(json: unknown): number | null {
  if (!json || typeof json !== 'object') return null;
  const j = json as { code?: string; routes?: Array<{ distance?: number }> };
  if (j.code !== 'Ok' || !Array.isArray(j.routes) || j.routes.length === 0) return null;
  const dist = j.routes[0]?.distance;
  return typeof dist === 'number' && Number.isFinite(dist) ? Math.round(dist) : null;
}

export type DriveEstimate = { seconds: number; meters: number | null };

/**
 * Free-flow driving estimate between two points via OSRM. Returns null on any
 * failure so callers can fall back to a manual estimate. OSRM expects
 * lon,lat order in the path.
 */
export async function driveEstimate(from: LatLng, to: LatLng): Promise<DriveEstimate | null> {
  try {
    const coords = `${from.lng},${from.lat};${to.lng},${to.lat}`;
    const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=false&alternatives=false`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) return null;
    const json = await readBoundedResponseJson<unknown>(res, 512 * 1024);
    const seconds = parseOsrmDuration(json);
    if (seconds == null) return null;
    return { seconds, meters: parseOsrmDistance(json) };
  } catch {
    return null;
  }
}

/** Miles from meters, rounded to 1 decimal. */
export function metersToMiles(meters: number | null): number | null {
  if (meters == null) return null;
  return Math.round((meters / 1609.34) * 10) / 10;
}

/**
 * Rough fallback driving time when routing is unavailable: assumes ~30 mph
 * average door-to-door (city + suburban mix). `miles` is the straight-line or
 * known distance. Returns whole seconds.
 */
export function fallbackDriveSeconds(miles: number, avgMph = 30): number {
  if (!Number.isFinite(miles) || miles <= 0) return 0;
  return Math.round((miles / Math.max(5, avgMph)) * 3600);
}

/** Haversine distance in miles between two points (for the fallback estimate). */
export function haversineMiles(a: LatLng, b: LatLng): number {
  const R = 3958.8; // earth radius miles
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)) * 10) / 10;
}
