// Provider-agnostic event normalization + the discovery window. Pure + tested.
// Currently maps Ticketmaster Discovery API responses into our weekend_events shape.
import { instantForIcsLocalTime, isValidTimezone } from '@/lib/time/zoned';

export type NormalizedEvent = {
  source: string;
  external_id: string | null;
  title: string;
  category: string | null;
  description: string | null;
  venue_name: string | null;
  address: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  latitude: number | null;
  longitude: number | null;
  starts_at: string | null;
  ends_at: string | null;
  url: string | null;
  image_url: string | null;
  price_min_cents: number | null;
  price_max_cents: number | null;
  currency: string;
  distance_miles: number | null;
  is_family_friendly: boolean;
};

/**
 * The instant a civil date (`YYYY-MM-DD`) begins in `timeZone`, as
 * `YYYY-MM-DDTHH:MM:SSZ`. An event published with a DATE and no time is an
 * all-day event on that date where the family is; written as UTC midnight it
 * was 5 PM the evening before in California and filed under that day. UTC
 * when no usable zone is given, which is what it always was. Null for a value
 * that is not a date.
 */
export function civilDayStart(dateKey: string, timeZone: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!m) return null;
  const zone = timeZone && isValidTimezone(timeZone) ? timeZone : 'UTC';
  const at = instantForIcsLocalTime(+m[1], +m[2], +m[3], 0, zone);
  if (!at || Number.isNaN(at.getTime())) return null;
  return at.toISOString().replace('.000Z', 'Z');
}

/** The day after a civil date, as `YYYY-MM-DD`. */
function nextDayKey(dateKey: string): string {
  const next = new Date(`${dateKey}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

/** ISO start/end for a discovery window of `days` days from `now` (inclusive). */
export function discoveryWindow(days: number, now: Date = new Date()): { startISO: string; endISO: string } {
  const start = new Date(now);
  const end = new Date(now);
  end.setUTCDate(end.getUTCDate() + Math.max(1, days));
  end.setUTCHours(23, 59, 59, 0);
  return { startISO: start.toISOString(), endISO: end.toISOString() };
}

const toCents = (n: unknown): number | null => {
  const v = typeof n === 'number' ? n : typeof n === 'string' ? parseFloat(n) : NaN;
  return Number.isFinite(v) ? Math.round(v * 100) : null;
};

const pickImage = (images: unknown): string | null => {
  if (!Array.isArray(images)) return null;
  // prefer a wide 16:9 image
  const best = images.find((i): i is { url: string; ratio?: string; width?: number } => !!i && typeof i.url === 'string' && i.ratio === '16_9')
    ?? images.find((i): i is { url: string } => !!i && typeof i.url === 'string');
  return best?.url ?? null;
};

type TMEvent = {
  id?: string; name?: string; url?: string; info?: string; pleaseNote?: string;
  images?: unknown;
  dates?: { start?: { dateTime?: string; localDate?: string }; end?: { dateTime?: string }; timezone?: string };
  classifications?: { segment?: { name?: string }; genre?: { name?: string }; family?: boolean }[];
  priceRanges?: { min?: number; max?: number; currency?: string }[];
  distance?: number; units?: string;
  _embedded?: { venues?: { name?: string; city?: { name?: string }; state?: { stateCode?: string }; postalCode?: string; address?: { line1?: string }; location?: { latitude?: string; longitude?: string } }[] };
};

const kmToMiles = (km: number) => km * 0.621371;

/**
 * Map one Ticketmaster event into our normalized shape. An event with a date
 * and no time is placed at that date's midnight in the event's own zone (or
 * the family's, `timeZone`), and runs to the next, like an all-day ICS event.
 */
export function normalizeTicketmaster(e: TMEvent, timeZone: string | null = null): NormalizedEvent {
  const venue = e._embedded?.venues?.[0];
  const cls = e.classifications?.[0];
  const price = e.priceRanges?.[0];
  const lat = venue?.location?.latitude ? parseFloat(venue.location.latitude) : null;
  const lon = venue?.location?.longitude ? parseFloat(venue.location.longitude) : null;
  // Ticketmaster distance is in the requested unit; default API unit is miles when unit=miles passed.
  const distance = typeof e.distance === 'number'
    ? (e.units === 'km' ? kmToMiles(e.distance) : e.distance)
    : null;
  const category = cls?.genre?.name && cls.genre.name !== 'Undefined' ? cls.genre.name : (cls?.segment?.name ?? null);
  const localDate = e.dates?.start?.localDate ?? null;
  const zone = e.dates?.timezone && isValidTimezone(e.dates.timezone) ? e.dates.timezone : timeZone;

  return {
    source: 'ticketmaster',
    external_id: e.id ?? null,
    title: e.name ?? 'Untitled event',
    category,
    description: e.info ?? e.pleaseNote ?? null,
    venue_name: venue?.name ?? null,
    address: venue?.address?.line1 ?? null,
    city: venue?.city?.name ?? null,
    region: venue?.state?.stateCode ?? null,
    postal_code: venue?.postalCode ?? null,
    latitude: Number.isFinite(lat) ? lat : null,
    longitude: Number.isFinite(lon) ? lon : null,
    starts_at: e.dates?.start?.dateTime ?? (localDate ? civilDayStart(localDate, zone) : null),
    ends_at: e.dates?.end?.dateTime ?? (!e.dates?.start?.dateTime && localDate ? civilDayStart(nextDayKey(localDate), zone) : null),
    url: e.url ?? null,
    image_url: pickImage(e.images),
    price_min_cents: toCents(price?.min),
    price_max_cents: toCents(price?.max),
    currency: price?.currency ?? 'USD',
    distance_miles: distance != null ? Math.round(distance * 10) / 10 : null,
    is_family_friendly: cls?.family === true || /family|children/i.test(category ?? ''),
  };
}

/** Map a full Ticketmaster Discovery response into normalized events. */
export function normalizeTicketmasterResponse(json: unknown, timeZone: string | null = null): NormalizedEvent[] {
  const events = (json as { _embedded?: { events?: TMEvent[] } })?._embedded?.events;
  if (!Array.isArray(events)) return [];
  return events.map((event) => normalizeTicketmaster(event, timeZone));
}
