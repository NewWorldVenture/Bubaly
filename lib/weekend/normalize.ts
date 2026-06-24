// Provider-agnostic event normalization + the discovery window. Pure + tested.
// Currently maps Ticketmaster Discovery API responses into our weekend_events shape.

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

/** ISO start/end for a discovery window of `days` days from `now` (inclusive). */
export function discoveryWindow(days: number, now: Date = new Date()): { startISO: string; endISO: string } {
  const start = new Date(now);
  const end = new Date(now);
  end.setDate(end.getDate() + Math.max(1, days));
  end.setHours(23, 59, 59, 0);
  return { startISO: start.toISOString().slice(0, 19) + 'Z', endISO: end.toISOString().slice(0, 19) + 'Z' };
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
  dates?: { start?: { dateTime?: string; localDate?: string }; end?: { dateTime?: string } };
  classifications?: { segment?: { name?: string }; genre?: { name?: string }; family?: boolean }[];
  priceRanges?: { min?: number; max?: number; currency?: string }[];
  distance?: number; units?: string;
  _embedded?: { venues?: { name?: string; city?: { name?: string }; state?: { stateCode?: string }; postalCode?: string; address?: { line1?: string }; location?: { latitude?: string; longitude?: string } }[] };
};

const kmToMiles = (km: number) => km * 0.621371;

/** Map one Ticketmaster event into our normalized shape. */
export function normalizeTicketmaster(e: TMEvent): NormalizedEvent {
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
    starts_at: e.dates?.start?.dateTime ?? (e.dates?.start?.localDate ? `${e.dates.start.localDate}T00:00:00Z` : null),
    ends_at: e.dates?.end?.dateTime ?? null,
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
export function normalizeTicketmasterResponse(json: unknown): NormalizedEvent[] {
  const events = (json as { _embedded?: { events?: TMEvent[] } })?._embedded?.events;
  if (!Array.isArray(events)) return [];
  return events.map(normalizeTicketmaster);
}
