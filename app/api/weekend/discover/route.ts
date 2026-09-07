import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { enforceRequestRateLimit } from '@/lib/server/request-rate-limit';
import { discoveryWindow, normalizeTicketmasterResponse, type NormalizedEvent } from '@/lib/weekend/normalize';
import { normalizeSeatGeekResponse, parseICS, parseRSS, withinWindow, dedupeEvents } from '@/lib/weekend/sources';
import { MAX_SMALL_JSON_BYTES, readBoundedRequestJsonOrEmpty } from '@/lib/server/bounded-request-body';
import { fetchPublicCalendarText } from '@/lib/server/public-calendar-fetch';
import { readBoundedResponseJson } from '@/lib/server/bounded-response-body';
import { isValidZip, RADIUS_OPTIONS, DEFAULT_RADIUS, DEFAULT_DAYS } from '@/lib/weekend/meta';

export const runtime = 'nodejs';

const FETCH_TIMEOUT = 9000;
async function fetchWithTimeout(url: string, ms = FETCH_TIMEOUT): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { headers: { accept: '*/*', 'user-agent': 'BubalyWeekendPlanner/1.0' }, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

// Aggregate local events near a ZIP for the next N days from MANY sources:
// Ticketmaster + SeatGeek (keyed, nationwide, ZIP+radius) plus the family's
// curated ICS/RSS local feeds (city, library, parks, school...). Deduped + cached.
export async function POST(req: NextRequest) {
  const tr = await getTranslations();
  let ctx;
  try { ctx = await requireUserContext(); } catch { return NextResponse.json({ error: tr('discover.unauthorized') }, { status: 401 }); }

  const supabase = await createServer();
  const limited = await enforceRequestRateLimit(supabase, `weekend:${ctx.user.id}`, { limit: 12 });
  if (!limited.ok) return NextResponse.json(
    { error: tr('discover.tooManyEventSearchesPlease') },
    { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
  );

  const boundedBody = await readBoundedRequestJsonOrEmpty(req, MAX_SMALL_JSON_BYTES);
  if (!boundedBody.ok) return NextResponse.json({ error: tr('discover.requestBodyIsTooLarge') }, { status: 400 });
  const { zip, radius, days } = (boundedBody.value ?? {}) as { zip?: string; radius?: number; days?: number };
  if (!zip || !isValidZip(zip)) return NextResponse.json({ error: tr('discover.enterAValid5Digit') }, { status: 400 });
  const radiusMiles = RADIUS_OPTIONS.includes(radius as never) ? radius! : DEFAULT_RADIUS;
  const windowDays = Number.isInteger(days) && days! >= 1 && days! <= 30 ? days! : DEFAULT_DAYS;
  const { startISO, endISO } = discoveryWindow(windowDays);

  const familyId = ctx.active.familyId;
  const sourcesUsed: string[] = [];
  const sourceErrors: Record<string, string> = {};
  const lists: NormalizedEvent[][] = [];

  // --- Ticketmaster (keyed) ---
  const tmKey = process.env.TICKETMASTER_API_KEY;
  if (tmKey) {
    sourcesUsed.push('ticketmaster');
    try {
      const p = new URLSearchParams({ apikey: tmKey, postalCode: zip.trim(), radius: String(radiusMiles), unit: 'miles', startDateTime: startISO, endDateTime: endISO, size: '100', sort: 'date,asc' });
      const res = await fetchWithTimeout(`https://app.ticketmaster.com/discovery/v2/events.json?${p}`);
      if (res.ok) lists.push(normalizeTicketmasterResponse(await readBoundedResponseJson<unknown>(res, 2 * 1024 * 1024)));
      else {
        sourceErrors.ticketmaster = `HTTP ${res.status}`;
        console.warn('Ticketmaster discovery failed:', res.status);
      }
    } catch (e) {
      console.warn('Ticketmaster discovery request failed:', e);
      sourceErrors.ticketmaster = 'Request failed.';
    }
  }

  // --- SeatGeek (keyed) ---
  const sgKey = process.env.SEATGEEK_CLIENT_ID;
  if (sgKey) {
    sourcesUsed.push('seatgeek');
    try {
      const p = new URLSearchParams({ client_id: sgKey, postal_code: zip.trim(), range: `${radiusMiles}mi`, 'datetime_utc.gte': startISO, 'datetime_utc.lte': endISO, per_page: '100', sort: 'datetime_utc.asc' });
      const res = await fetchWithTimeout(`https://api.seatgeek.com/2/events?${p}`);
      if (res.ok) lists.push(normalizeSeatGeekResponse(await readBoundedResponseJson<unknown>(res, 2 * 1024 * 1024)));
      else {
        sourceErrors.seatgeek = `HTTP ${res.status}`;
        console.warn('SeatGeek discovery failed:', res.status);
      }
    } catch (e) {
      console.warn('SeatGeek discovery request failed:', e);
      sourceErrors.seatgeek = 'Request failed.';
    }
  }

  // --- Family-curated local feeds (ICS / RSS) ---
  const { data: feeds } = await supabase.from('weekend_feeds').select('*').eq('family_id', familyId).eq('is_active', true);
  if (feeds && feeds.length) {
    await Promise.allSettled(feeds.map(async (feed) => {
      let status = 'ok'; let count = 0;
      try {
        const fetched = await fetchPublicCalendarText(feed.url);
        if (!fetched.ok) {
          status = fetched.status ? `HTTP ${fetched.status}` : 'Feed unavailable.';
          console.warn(`Weekend feed ${feed.id} failed:`, fetched.error);
        }
        else {
          const text = fetched.text;
          const parsed = feed.kind === 'rss' ? parseRSS(text, `feed:${feed.label}`) : parseICS(text, `feed:${feed.label}`);
          const windowed = withinWindow(parsed, windowDays);
          count = windowed.length;
          lists.push(windowed);
          sourcesUsed.push(`feed:${feed.label}`);
        }
      } catch (e) {
        console.warn(`Weekend feed ${feed.id} request failed:`, e);
        status = 'Request failed.';
      }
      await supabase.from('weekend_feeds').update({ last_fetched_at: new Date().toISOString(), last_status: status, last_count: count }).eq('id', feed.id);
    }));
  }

  // No sources at all → tell the user how to enable discovery (never fake data).
  if (sourcesUsed.length === 0) {
    return NextResponse.json({
      error: tr('discover.noEventSourcesAreConnected'),
      needsConfig: true,
    }, { status: 503 });
  }

  // Merge, keep only the window, dedupe across providers.
  const merged = dedupeEvents(lists.map((l) => withinWindow(l, windowDays)));

  if (merged.length) {
    const rows = merged
      .filter((e) => e.external_id)
      .map((e) => ({ ...e, family_id: familyId, search_zip: zip.trim(), search_radius: radiusMiles, discovered_at: new Date().toISOString(), created_by: ctx!.user.id }));
    if (rows.length) {
      const { error } = await supabase.from('weekend_events').upsert(rows, { onConflict: 'family_id,source,external_id' });
      if (error) {
        console.error('Weekend event write failed:', error);
        return NextResponse.json({ error: tr('discover.couldNotSaveDiscoveredEvents') }, { status: 500 });
      }
    }
  }

  await supabase.from('weekend_searches').insert({ family_id: familyId, zip: zip.trim(), radius_miles: radiusMiles, days: windowDays, result_count: merged.length, last_run_at: new Date().toISOString(), created_by: ctx.user.id });

  return NextResponse.json({ count: merged.length, zip: zip.trim(), radius: radiusMiles, days: windowDays, sources: sourcesUsed, errors: sourceErrors });
}
