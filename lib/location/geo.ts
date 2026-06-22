// lib/location/geo.ts — pure geo helpers for Family Location.
// No Supabase / React so haversine, geofence membership, transition detection,
// and labels stay deterministically unit-testable.

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

/** Compact "time ago" label from an ISO timestamp relative to `now`. */
export function timeAgo(iso: string, now: Date): string {
  const mins = Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
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
