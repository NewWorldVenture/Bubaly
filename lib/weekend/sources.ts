// Additional Weekend Planner sources: SeatGeek (keyed, nationwide) and
// standards-based ICS / RSS feeds (family-curated local calendars). All pure +
// unit-tested; network fetching happens in the API route.
import type { NormalizedEvent } from './normalize';

const toCents = (n: unknown): number | null => {
  const v = typeof n === 'number' ? n : typeof n === 'string' ? parseFloat(n) : NaN;
  return Number.isFinite(v) && v > 0 ? Math.round(v * 100) : null;
};

// ---------------- SeatGeek ----------------
type SGEvent = {
  id?: number | string; title?: string; url?: string; datetime_utc?: string; datetime_local?: string;
  type?: string; short_title?: string;
  venue?: { name?: string; address?: string; city?: string; state?: string; postal_code?: string; location?: { lat?: number; lon?: number } };
  stats?: { lowest_price?: number; highest_price?: number };
};

export function normalizeSeatGeek(e: SGEvent): NormalizedEvent {
  const v = e.venue;
  const cat = (e.type ?? '').replace(/_/g, ' ').trim() || null;
  return {
    source: 'seatgeek',
    external_id: e.id != null ? String(e.id) : null,
    title: e.title ?? e.short_title ?? 'Untitled event',
    category: cat,
    description: null,
    venue_name: v?.name ?? null,
    address: v?.address ?? null,
    city: v?.city ?? null,
    region: v?.state ?? null,
    postal_code: v?.postal_code ?? null,
    latitude: typeof v?.location?.lat === 'number' ? v.location.lat : null,
    longitude: typeof v?.location?.lon === 'number' ? v.location.lon : null,
    starts_at: e.datetime_utc ? `${e.datetime_utc}Z`.replace(/Z+$/, 'Z') : (e.datetime_local ?? null),
    ends_at: null,
    url: e.url ?? null,
    image_url: null,
    price_min_cents: toCents(e.stats?.lowest_price),
    price_max_cents: toCents(e.stats?.highest_price),
    currency: 'USD',
    distance_miles: null,
    is_family_friendly: /family|kid|children/i.test(cat ?? ''),
  };
}

export function normalizeSeatGeekResponse(json: unknown): NormalizedEvent[] {
  const events = (json as { events?: SGEvent[] })?.events;
  return Array.isArray(events) ? events.map(normalizeSeatGeek) : [];
}

// ---------------- ICS (iCalendar) ----------------
/** Unfold folded lines (RFC 5545: continuation lines start with space/tab). */
function unfoldICS(text: string): string[] {
  const raw = text.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  for (const line of raw) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length) out[out.length - 1] += line.slice(1);
    else out.push(line);
  }
  return out;
}

function unescapeICS(v: string): string {
  return v.replace(/\\n/gi, ' ').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\').trim();
}

/** Parse an ICS DTSTART value (with or without TZID/VALUE params) to ISO. */
export function parseICSDate(val: string): string | null {
  const v = val.trim();
  // 20260625T180000Z  | 20260625T180000 | 20260625
  let m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (m) {
    const [, y, mo, d, h, mi, s, z] = m;
    return z === 'Z' ? `${y}-${mo}-${d}T${h}:${mi}:${s}Z` : `${y}-${mo}-${d}T${h}:${mi}:${s}`;
  }
  m = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}T00:00:00`;
  return null;
}

export function parseICS(text: string, source = 'feed'): NormalizedEvent[] {
  const lines = unfoldICS(text);
  const events: NormalizedEvent[] = [];
  let cur: Record<string, string> | null = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT') {
      if (cur && (cur.SUMMARY || cur.summary)) {
        const start = cur.DTSTART != null ? parseICSDate(cur.DTSTART) : null;
        events.push({
          source, external_id: cur.UID || null,
          title: unescapeICS(cur.SUMMARY ?? 'Event'),
          category: cur.CATEGORIES ? unescapeICS(cur.CATEGORIES) : null,
          description: cur.DESCRIPTION ? unescapeICS(cur.DESCRIPTION).slice(0, 500) : null,
          venue_name: cur.LOCATION ? unescapeICS(cur.LOCATION) : null,
          address: cur.LOCATION ? unescapeICS(cur.LOCATION) : null,
          city: null, region: null, postal_code: null, latitude: null, longitude: null,
          starts_at: start, ends_at: cur.DTEND ? parseICSDate(cur.DTEND) : null,
          url: cur.URL || null, image_url: null,
          price_min_cents: null, price_max_cents: null, currency: 'USD',
          distance_miles: null, is_family_friendly: /family|kid|children/i.test(`${cur.SUMMARY} ${cur.CATEGORIES ?? ''}`),
        });
      }
      cur = null; continue;
    }
    if (!cur) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue; // malformed line, skip
    const keyPart = line.slice(0, idx);
    const value = line.slice(idx + 1);
    const key = keyPart.split(';')[0].toUpperCase(); // drop params like ;TZID=...
    cur[key] = value;
  }
  return events;
}

// ---------------- RSS / Atom ----------------
const tag = (block: string, name: string): string | null => {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  if (!m) return null;
  return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '').trim() || null;
};

export function parseRSS(text: string, source = 'feed'): NormalizedEvent[] {
  const out: NormalizedEvent[] = [];
  const items = text.match(/<item[\s\S]*?<\/item>/gi) ?? text.match(/<entry[\s\S]*?<\/entry>/gi) ?? [];
  for (const block of items) {
    const title = tag(block, 'title');
    if (!title) continue;
    const link = tag(block, 'link') ?? (block.match(/<link[^>]*href="([^"]+)"/i)?.[1] ?? null);
    const dateStr = tag(block, 'pubDate') ?? tag(block, 'published') ?? tag(block, 'updated') ?? tag(block, 'dc:date');
    const parsed = dateStr ? new Date(dateStr) : null;
    out.push({
      source, external_id: tag(block, 'guid') ?? link,
      title, category: tag(block, 'category'),
      description: (tag(block, 'description') ?? tag(block, 'summary'))?.slice(0, 500) ?? null,
      venue_name: null, address: null, city: null, region: null, postal_code: null,
      latitude: null, longitude: null,
      starts_at: parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : null,
      ends_at: null, url: link, image_url: null,
      price_min_cents: null, price_max_cents: null, currency: 'USD',
      distance_miles: null, is_family_friendly: /family|kid|children/i.test(title),
    });
  }
  return out;
}

// ---------------- shared helpers ----------------
/** Keep events that start within [now - grace, now + days]. */
export function withinWindow(events: NormalizedEvent[], days: number, now: Date = new Date()): NormalizedEvent[] {
  const lo = now.getTime() - 3_600_000;
  const hi = now.getTime() + days * 86_400_000;
  return events.filter((e) => {
    if (!e.starts_at) return false;
    const t = new Date(e.starts_at).getTime();
    return !Number.isNaN(t) && t >= lo && t <= hi;
  });
}

/** Merge multiple source lists, de-duplicating by source+external_id then title+day. */
export function dedupeEvents(lists: NormalizedEvent[][]): NormalizedEvent[] {
  const seen = new Set<string>();
  const out: NormalizedEvent[] = [];
  for (const list of lists) for (const e of list) {
    const idKey = e.external_id ? `${e.source}:${e.external_id}` : '';
    const softKey = `${e.title.toLowerCase()}|${(e.starts_at ?? '').slice(0, 10)}`;
    if (idKey && seen.has(idKey)) continue;
    if (seen.has(softKey)) continue;
    if (idKey) seen.add(idKey);
    seen.add(softKey);
    out.push(e);
  }
  return out;
}
