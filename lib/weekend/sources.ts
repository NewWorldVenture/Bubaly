// Additional Weekend Planner sources: SeatGeek (keyed, nationwide) and
// standards-based ICS / RSS feeds (family-curated local calendars). All pure +
// unit-tested; network fetching happens in the API route.
import { civilDayStart, type NormalizedEvent } from './normalize';
import { instantForIcsLocalTime, isValidTimezone } from '@/lib/time/zoned';

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

/**
 * Parse an ICS DTSTART/DTEND value to an ISO instant, with the TZID the content
 * line carried.
 *
 *   20260625T180000Z            → 2026-06-25T18:00:00Z
 *   20260625T180000 + TZID      → the instant at which the clock in that zone
 *                                 reads 18:00 (a library's "Saturday story time
 *                                 at 10" is published in its own zone; read as
 *                                 UTC it showed hours off). On a DST night RFC
 *                                 5545 §3.3.5 decides (instantForIcsLocalTime):
 *                                 a reading shown twice is the FIRST instant, one
 *                                 skipped takes the offset in force BEFORE the gap.
 *   20260625T180000, no TZID    → read as UTC. Before, this came back WITHOUT a
 *                                 zone and `new Date()` then read it in the
 *                                 runtime's zone — UTC on the server that runs
 *                                 the discovery route, so the instant is the
 *                                 same there and now does not depend on where
 *                                 the code runs.
 *   20260625                    → the start of that date in `dateZone`, the
 *                                 FAMILY's zone. A date-only DTSTART is an
 *                                 all-day event, a civil date with no instant,
 *                                 and it read as UTC midnight: 5 PM the day
 *                                 before in California, filed under the wrong
 *                                 day. UTC when no zone is given.
 *
 * A TZID this runtime does not know (Windows names) falls back to the floating
 * rule rather than dropping the event; this is discovery, not the family's own
 * calendar, and an event an hour off beats one missing. The limit is stated.
 */
export function parseICSDate(val: string, tzid: string | null = null, dateZone: string | null = null): string | null {
  const v = val.trim();
  // 20260625T180000Z  | 20260625T180000 | 20260625
  let m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (m) {
    const [, y, mo, d, h, mi, s, z] = m;
    if (!z && tzid && isValidTimezone(tzid)) {
      const at = instantForIcsLocalTime(+y, +mo, +d, +h * 60 + +mi, tzid);
      if (at) return new Date(at.getTime() + +s * 1000).toISOString().replace('.000Z', 'Z');
    }
    return `${y}-${mo}-${d}T${h}:${mi}:${s}Z`;
  }
  m = v.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return civilDayStart(`${m[1]}-${m[2]}-${m[3]}`, dateZone);
  return null;
}

/** `YYYYMMDD`, the value of an all-day (VALUE=DATE) DTSTART or DTEND. */
const isDateOnly = (val: string | undefined) => !!val && /^\d{8}$/.test(val.trim());

/** The civil date after an all-day value: where an all-day event with no DTEND ends (RFC 5545 §3.6.1). */
function nextDateKey(val: string): string {
  const v = val.trim();
  const next = new Date(Date.UTC(+v.slice(0, 4), +v.slice(4, 6) - 1, +v.slice(6, 8) + 1));
  return next.toISOString().slice(0, 10).replace(/-/g, '');
}

/**
 * The value starts at the first `:` outside double quotes: a quoted parameter
 * may carry a colon (`TZID="(UTC-05:00) Eastern Time (US & Canada)"`), and the
 * first colon blindly made the parameter the value.
 */
function splitContentLine(line: string): { key: string; tzid: string | null; value: string } | null {
  let quoted = false;
  let colon = -1;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (ch === ':' && !quoted) { colon = i; break; }
  }
  if (colon === -1) return null;
  const [rawKey, ...params] = line.slice(0, colon).split(';');
  let tzid: string | null = null;
  for (const param of params) {
    const zone = param.match(/^TZID=(.+)$/i);
    if (zone) tzid = zone[1].replace(/^"(.*)"$/, '$1');
  }
  return { key: rawKey.toUpperCase(), tzid, value: line.slice(colon + 1) };
}

/**
 * `timeZone` is the family's: an all-day event (a date-only DTSTART) starts
 * at its midnight and, with no DTEND, ends at the next one, so the event is
 * filed under its own day and stays discoverable through it.
 */
export function parseICS(text: string, source = 'feed', timeZone: string | null = null): NormalizedEvent[] {
  const lines = unfoldICS(text);
  const events: NormalizedEvent[] = [];
  let cur: Record<string, string> | null = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT') {
      if (cur && (cur.SUMMARY || cur.summary)) {
        const start = cur.DTSTART != null ? parseICSDate(cur.DTSTART, cur['DTSTART;TZID'] ?? null, timeZone) : null;
        const end = cur.DTEND != null ? parseICSDate(cur.DTEND, cur['DTEND;TZID'] ?? null, timeZone)
          : start && isDateOnly(cur.DTSTART) ? parseICSDate(nextDateKey(cur.DTSTART), null, timeZone) : null;
        events.push({
          source, external_id: cur.UID || null,
          title: unescapeICS(cur.SUMMARY ?? 'Event'),
          category: cur.CATEGORIES ? unescapeICS(cur.CATEGORIES) : null,
          description: cur.DESCRIPTION ? unescapeICS(cur.DESCRIPTION).slice(0, 500) : null,
          venue_name: cur.LOCATION ? unescapeICS(cur.LOCATION) : null,
          address: cur.LOCATION ? unescapeICS(cur.LOCATION) : null,
          city: null, region: null, postal_code: null, latitude: null, longitude: null,
          starts_at: start, ends_at: end,
          url: cur.URL || null, image_url: null,
          price_min_cents: null, price_max_cents: null, currency: 'USD',
          distance_miles: null, is_family_friendly: /family|kid|children/i.test(`${cur.SUMMARY} ${cur.CATEGORIES ?? ''}`),
        });
      }
      cur = null; continue;
    }
    if (!cur) continue;
    const parsed = splitContentLine(line);
    if (!parsed) continue; // malformed line, skip
    const { key, tzid, value } = parsed;
    cur[key] = value;
    // The zone a date was published in travels beside it; other parameters are dropped.
    if (tzid && (key === 'DTSTART' || key === 'DTEND')) cur[`${key};TZID`] = tzid;
  }
  return events;
}

// ---------------- RSS / Atom ----------------
// Every scan below is LINEAR: one forward `indexOf` pass, never a lazy regex.
// A feed is any URL a family member saves, read in full (up to 1 MiB), and
// `/<item[\s\S]*?<\/item>/` rescans to the end of the text from EVERY `<item`
// that is never closed — quadratic, about a minute of blocked event loop for
// one megabyte of `<item`, per feed, per search. The tag, CDATA and markup
// passes had the same shape inside one oversized item.

/** Items read from one feed, and the longest text kept from any one field. */
const MAX_RSS_ITEMS = 500;
const MAX_RSS_FIELD_CHARS = 4000;

/**
 * ASCII-only lowercase, so every index into it is an index into the original:
 * `toLowerCase()` turns some letters into two code units ('İ' → 'i̇'), and a
 * slice taken by its offsets would be off by one for each.
 */
const asciiLower = (text: string) => text.replace(/[A-Z]+/g, (run) => run.toLowerCase());

/** The character after a tag name: the name ends there, so `<item` is not `<itemref`. */
const endsName = (ch: string | undefined) => ch === undefined || ch === '>' || ch === '/' || /\s/.test(ch);

/** `<![CDATA[…]]>` unwrapped, in one pass. An unterminated section is left as it is. */
function unwrapCdata(text: string): string {
  let out = '';
  let from = 0;
  for (;;) {
    const open = text.indexOf('<![CDATA[', from);
    if (open === -1) return out + text.slice(from);
    const close = text.indexOf(']]>', open + 9);
    if (close === -1) return out + text.slice(from);
    out += text.slice(from, open) + text.slice(open + 9, close);
    from = close + 3;
  }
}

/** Markup removed, in one pass: `<…>` with something inside. A `<` never closed is text. */
function stripTags(text: string): string {
  let out = '';
  let from = 0;
  for (;;) {
    const lt = text.indexOf('<', from);
    if (lt === -1) return out + text.slice(from);
    const gt = text.indexOf('>', lt + 1);
    if (gt === -1) return out + text.slice(from);
    if (gt === lt + 1) { out += text.slice(from, gt + 1); from = gt + 1; continue; }
    out += text.slice(from, lt);
    from = gt + 1;
  }
}

/** The text of the first `<name …>…</name>` in a block, case-insensitively, or null. */
const tag = (block: string, name: string): string | null => {
  const lower = asciiLower(block);
  const open = `<${asciiLower(name)}`;
  const close = `</${asciiLower(name)}>`;
  for (let from = 0; ;) {
    const start = lower.indexOf(open, from);
    if (start === -1) return null;
    if (!endsName(lower[start + open.length])) { from = start + open.length; continue; }
    const gt = lower.indexOf('>', start + open.length);
    if (gt === -1) return null;
    const end = lower.indexOf(close, gt + 1);
    // No closing tag after this one means none after any later one either.
    if (end === -1) return null;
    return stripTags(unwrapCdata(block.slice(gt + 1, end).slice(0, MAX_RSS_FIELD_CHARS))).trim() || null;
  }
};

/** Each `<name …>…</name>` block, in order, stopping at the first one never closed. */
function blocksOf(text: string, lower: string, name: string): string[] {
  const open = `<${name}`;
  const close = `</${name}>`;
  const out: string[] = [];
  for (let from = 0; out.length < MAX_RSS_ITEMS;) {
    const start = lower.indexOf(open, from);
    if (start === -1) break;
    if (!endsName(lower[start + open.length])) { from = start + open.length; continue; }
    const end = lower.indexOf(close, start + open.length);
    if (end === -1) break;
    out.push(text.slice(start, end + close.length));
    from = end + close.length;
  }
  return out;
}

/** The `href` of the first `<link …>` (Atom's form), scanning each tag once. */
function linkHref(block: string): string | null {
  const lower = asciiLower(block);
  for (let from = 0; ;) {
    const start = lower.indexOf('<link', from);
    if (start === -1) return null;
    if (!endsName(lower[start + 5])) { from = start + 5; continue; }
    const gt = lower.indexOf('>', start + 5);
    if (gt === -1) return null;
    const href = /href="([^"]+)"/i.exec(block.slice(start + 5, gt))?.[1];
    if (href) return href.slice(0, MAX_RSS_FIELD_CHARS);
    from = gt + 1;
  }
}

export function parseRSS(text: string, source = 'feed'): NormalizedEvent[] {
  const out: NormalizedEvent[] = [];
  const lower = asciiLower(text);
  const rssItems = blocksOf(text, lower, 'item');
  const items = rssItems.length ? rssItems : blocksOf(text, lower, 'entry');
  for (const block of items) {
    const title = tag(block, 'title')?.slice(0, 300) ?? null;
    if (!title) continue;
    const link = tag(block, 'link') ?? linkHref(block);
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
/**
 * Keep events that start by `now + days` and are not over: they start, or
 * end, after `now - grace`. An all-day event starts at midnight and runs all
 * day, so its start alone dropped it an hour into its own day — and, read as
 * UTC midnight, from 6 PM the evening before in California.
 */
export function withinWindow(events: NormalizedEvent[], days: number, now: Date = new Date()): NormalizedEvent[] {
  const lo = now.getTime() - 3_600_000;
  const hi = now.getTime() + days * 86_400_000;
  return events.filter((e) => {
    if (!e.starts_at) return false;
    const t = new Date(e.starts_at).getTime();
    if (Number.isNaN(t) || t > hi) return false;
    const end = e.ends_at ? new Date(e.ends_at).getTime() : Number.NaN;
    return Math.max(t, Number.isNaN(end) ? t : end) >= lo;
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
