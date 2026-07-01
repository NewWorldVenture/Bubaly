// lib/location/overview.ts
// Pure, deterministic helpers for the Location dashboard: projecting lat/lng onto
// the stylized map panel, grouping location events into a per-day history, picking
// out arrival alerts, and formatting battery/"since" labels. No DB/network — every
// function is a pure transform of already-fetched rows so the math is unit-tested
// directly and reused by the client module.

import type { LatLng } from './geo';

export type Projected = { id: string; xPct: number; yPct: number };

/**
 * Project geo points into 0–100% x/y coordinates within the map panel, using the
 * combined bounding box (so all pins fit) plus a padding margin. Latitude is
 * flipped (north = top). A single point (or degenerate box) lands centered.
 */
export function projectPoints(
  points: { id: string; latitude: number | null; longitude: number | null }[],
  padPct = 12,
): Projected[] {
  const valid = points.filter((p): p is { id: string; latitude: number; longitude: number } =>
    p.latitude != null && p.longitude != null && Number.isFinite(p.latitude) && Number.isFinite(p.longitude));
  if (valid.length === 0) return [];
  const lats = valid.map((p) => p.latitude);
  const lngs = valid.map((p) => p.longitude);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const latSpan = maxLat - minLat || 1;
  const lngSpan = maxLng - minLng || 1;
  const span = 100 - padPct * 2;
  return valid.map((p) => ({
    id: p.id,
    xPct: padPct + ((p.longitude - minLng) / lngSpan) * span,
    // Flip latitude so higher latitude renders nearer the top.
    yPct: padPct + ((maxLat - p.latitude) / latSpan) * span,
  }));
}

export type HistoryEventLike = {
  id: string;
  member_id: string;
  place_name: string | null;
  event_type: string; // 'arrived' | 'left' | 'ping'
  occurred_at: string;
};

export type HistoryDay = { key: string; label: string; count: number; events: HistoryEventLike[] };

function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Group events into day buckets (newest first), labelled Today / Yesterday / date.
 * `count` is the number of distinct places visited that day (arrivals), matching
 * the "12 places" style counter in the mock.
 */
export function groupHistoryByDay(events: HistoryEventLike[], now: Date = new Date()): HistoryDay[] {
  const todayKey = dayKey(now.toISOString());
  const yesterdayKey = dayKey(new Date(now.getTime() - 86400000).toISOString());
  const byDay = new Map<string, HistoryEventLike[]>();
  for (const e of [...events].sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1))) {
    const k = dayKey(e.occurred_at);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k)!.push(e);
  }
  return [...byDay.entries()].map(([key, evs]) => {
    const places = new Set(evs.filter((e) => e.event_type === 'arrived').map((e) => e.place_name ?? e.id));
    const label = key === todayKey ? 'Today' : key === yesterdayKey ? 'Yesterday'
      : new Date(`${key}T00:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
    return { key, label, count: places.size || evs.length, events: evs };
  });
}

/** Recent arrival events → the "Place Alerts" rail. */
export function arrivalAlerts<T extends { event_type: string }>(events: T[], limit = 6): T[] {
  return events.filter((e) => e.event_type === 'arrived').slice(0, limit);
}

/** Battery bar color band by percentage. */
export function batteryTone(pct: number | null): 'ok' | 'low' | 'critical' | 'unknown' {
  if (pct == null) return 'unknown';
  if (pct <= 15) return 'critical';
  if (pct <= 35) return 'low';
  return 'ok';
}

/**
 * "Since" label for a member's current stay: "Now" when very recent, else the
 * clock time they were last placed ("Since 8:15 AM").
 */
export function sinceLabel(iso: string | null, now: Date = new Date()): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const mins = (now.getTime() - d.getTime()) / 60000;
  if (mins < 3) return 'Now';
  return `Since ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
}

/** Distance of a point from a place center via the shared haversine — re-exported for the map. */
export type { LatLng };
