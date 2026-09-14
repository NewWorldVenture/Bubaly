// lib/location/geo.ts — pure geo helpers for Family Location.
// No Supabase / React so haversine, geofence membership, transition detection,
// and labels stay deterministically unit-testable.

import { createFormat } from '@/lib/utils/format';
import { DEFAULT_LOCALE, type LocaleCode } from '@/lib/i18n/locales';

export interface LatLng { latitude: number; longitude: number }

export interface PlaceLike extends LatLng {
  id: string;
  name: string;
  radius_m: number;
}

const EARTH_M = 6_371_000;
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in metres between two points (haversine). */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = rad(b.latitude - a.latitude);
  const dLng = rad(b.longitude - a.longitude);
  const lat1 = rad(a.latitude);
  const lat2 = rad(b.latitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The saved place whose geofence currently contains `point`. When several
 * overlap, the closest (by centre distance) wins. Returns null when outside all.
 */
export function placeForPoint(places: PlaceLike[], point: LatLng): PlaceLike | null {
  let best: PlaceLike | null = null;
  let bestDist = Infinity;
  for (const p of places) {
    const d = haversineMeters(p, point);
    if (d <= p.radius_m && d < bestDist) {
      best = p;
      bestDist = d;
    }
  }
  return best;
}

export type Transition = 'arrived' | 'left' | 'moved' | 'none';

/**
 * Classifies the change between a member's previous and current geofence place.
 *  none    — same place (incl. both null/away)
 *  arrived — entered a place from elsewhere
 *  left    — exited a place to open ground
 *  moved   — went directly from one place to another
 */
export function classifyTransition(prevPlaceId: string | null, nextPlaceId: string | null): Transition {
  if (prevPlaceId === nextPlaceId) return 'none';
  if (!prevPlaceId && nextPlaceId) return 'arrived';
  if (prevPlaceId && !nextPlaceId) return 'left';
  return 'moved';
}

/**
 * Compact "time ago" label from an ISO timestamp relative to `now`.
 *
 * NOTE: nothing in the application calls this. It is exported and unit-tested and
 * no surface renders it — `components/modules/locator-module.tsx` uses
 * `sinceLabel` from lib/location/overview.ts instead. Kept because it is public
 * API another surface may reach for; recorded because a tested export with no
 * caller is a guard measuring nothing.
 */
export function timeAgo(iso: string, now: Date, locale: LocaleCode = DEFAULT_LOCALE): string {
  return createFormat(locale).fmtTimeAgo(iso, { now });
}

/** Human distance label (m under 1 km, else km to one decimal). */
export function distanceLabel(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

/** Location is "stale" when older than `minutes` (default 30). */
export function isStale(iso: string, now: Date, minutes = 30): boolean {
  return now.getTime() - new Date(iso).getTime() > minutes * 60000;
}
