import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { refuseUnlessEntitled } from '@/lib/server/route-feature-gate';
import { enforceRequestRateLimit } from '@/lib/server/request-rate-limit';
import { discoveryWindow, normalizeTicketmasterResponse, type NormalizedEvent } from '@/lib/weekend/normalize';
import { normalizeSeatGeekResponse, parseICS, parseRSS, withinWindow, dedupeEvents } from '@/lib/weekend/sources';
import { MAX_SMALL_JSON_BYTES, readBoundedRequestJsonOrEmpty } from '@/lib/server/bounded-request-body';
import { fetchPublicCalendarText } from '@/lib/server/public-calendar-fetch';
import { readBoundedResponseJson } from '@/lib/server/bounded-response-body';
import { isValidZip, RADIUS_OPTIONS, DEFAULT_RADIUS, DEFAULT_DAYS } from '@/lib/weekend/meta';
import { describeReadError } from '@/lib/supabase/settle';

export const runtime = 'nodejs';

const FETCH_TIMEOUT = 9000;

/**
 * How much of a family's own feed list one search reads. Any member may save a
 * feed, as many as they like, and every one of them used to be fetched AT
 * ONCE on every search: a few hundred saved URLs on a slow host were a few
 * hundred concurrent outbound requests, each holding up to 1 MiB, from one
 * request. A search now reads the feeds fetched longest ago, a few at a time,
 * until a deadline: a feed not started, or still reading, when it passes waits
 * for the next search and is reported as skipped. The deadline bounds the
 * reads themselves; each answered feed's status write follows it. The per-family cap on saved feeds is the
 * database's to enforce (a member inserts them directly).
 */
const MAX_FEEDS_PER_SEARCH = 12;
const FEED_CONCURRENCY = 4;
const FEEDS_DEADLINE_MS = 25_000;
/** Any saved feed that did not answer: said once per search, however many failed. Each feed's own row keeps its status. */
const FEEDS_FAILED = 'Some of your saved local feeds could not be read.';
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
  // The page in front of this is feature-gated; this endpoint was not.
  // Same resolver, so the two cannot disagree.
  const refused = await refuseUnlessEntitled(supabase, ctx.active.familyId, ['/dashboard/weekend']);
  if (refused) return refused;
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
  // An all-day event is a date where the FAMILY is: read at its midnight, not Greenwich's.
  const familyZone = ctx.active.family?.timezone || null;
  // A source is USED once it answered. Pushed before the fetch, a provider
  // that failed still counted, so a search where every source failed came
  // back 200 "No events found" — an outage reported as an empty weekend.
  const sourcesUsed: string[] = [];
  const sourcesTried: string[] = [];
  const sourceErrors: Record<string, string> = {};
  const lists: NormalizedEvent[][] = [];

  // --- Ticketmaster (keyed) ---
  const tmKey = process.env.TICKETMASTER_API_KEY;
  if (tmKey) {
    sourcesTried.push('ticketmaster');
    try {
      const p = new URLSearchParams({ apikey: tmKey, postalCode: zip.trim(), radius: String(radiusMiles), unit: 'miles', startDateTime: startISO, endDateTime: endISO, size: '100', sort: 'date,asc' });
      const res = await fetchWithTimeout(`https://app.ticketmaster.com/discovery/v2/events.json?${p}`);
      if (res.ok) {
        lists.push(normalizeTicketmasterResponse(await readBoundedResponseJson<unknown>(res, 2 * 1024 * 1024), familyZone));
        sourcesUsed.push('ticketmaster');
      } else {
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
    sourcesTried.push('seatgeek');
    try {
      const p = new URLSearchParams({ client_id: sgKey, postal_code: zip.trim(), range: `${radiusMiles}mi`, 'datetime_utc.gte': startISO, 'datetime_utc.lte': endISO, per_page: '100', sort: 'datetime_utc.asc' });
      const res = await fetchWithTimeout(`https://api.seatgeek.com/2/events?${p}`);
      if (res.ok) {
        lists.push(normalizeSeatGeekResponse(await readBoundedResponseJson<unknown>(res, 2 * 1024 * 1024)));
        sourcesUsed.push('seatgeek');
      } else {
        sourceErrors.seatgeek = `HTTP ${res.status}`;
        console.warn('SeatGeek discovery failed:', res.status);
      }
    } catch (e) {
      console.warn('SeatGeek discovery request failed:', e);
      sourceErrors.seatgeek = 'Request failed.';
    }
  }

  // --- Family-curated local feeds (ICS / RSS) ---
  // This route already has a channel for partial failure — `sourceErrors`, which
  // every external provider above reports into. The family's OWN curated feeds
  // were the one source that could fail silently: a refused read left `feeds`
  // empty, the block below was skipped, and the response came back looking
  // complete while omitting the only source the family configured themselves.
  // Reported through the existing mechanism rather than a new one. C1-S9-41.
  // The ones fetched longest ago first (never-fetched before all), one past
  // the cap so a longer list is known to be longer.
  const { data: savedFeeds, error: feedsError } = await supabase.from('weekend_feeds').select('*').eq('family_id', familyId).eq('is_active', true)
    .order('last_fetched_at', { ascending: true, nullsFirst: true }).order('id').limit(MAX_FEEDS_PER_SEARCH + 1);
  if (feedsError) {
    sourcesTried.push('feeds');
    console.error('[weekend/discover] feed read failed', { familyId, error: describeReadError(feedsError) });
    sourceErrors.feeds = 'Your saved local feeds could not be loaded.';
  }
  const feeds = (savedFeeds ?? []).slice(0, MAX_FEEDS_PER_SEARCH);
  let feedsSkipped = Math.max(0, (savedFeeds?.length ?? 0) - MAX_FEEDS_PER_SEARCH);
  if (feeds && feeds.length) {
    // One feed's fetch and parse. Its events are the caller's to use: a read
    // still running at the deadline is dropped, not merged in late.
    type FeedRead = { events: NormalizedEvent[]; status: string };
    const fetchFeed = async (feed: (typeof feeds)[number]): Promise<FeedRead> => {
      try {
        const fetched = await fetchPublicCalendarText(feed.url);
        if (!fetched.ok) {
          console.warn(`Weekend feed ${feed.id} failed:`, fetched.error);
          return { events: [], status: fetched.status ? `HTTP ${fetched.status}` : 'Feed unavailable.' };
        }
        const parsed = feed.kind === 'rss' ? parseRSS(fetched.text, `feed:${feed.label}`) : parseICS(fetched.text, `feed:${feed.label}`, familyZone);
        return { events: withinWindow(parsed, windowDays), status: 'ok' };
      } catch (e) {
        console.warn(`Weekend feed ${feed.id} request failed:`, e);
        return { events: [], status: 'Request failed.' };
      }
    };
    // Bookkeeping on the feed row: its result was discarded whole, so a
    // settings page could go on showing a stale "last fetched" forever. Zero
    // rows is a feed deleted mid-request and stays ordinary; an error is
    // logged, and so is a write that THROWS — which used to end the worker
    // that awaited it, and with it every feed still queued behind. Audit C1-S9-62.
    const recordFeedStatus = async (feed: (typeof feeds)[number], read: FeedRead) => {
      try {
        const { error: statusError } = await supabase.from('weekend_feeds')
          .update({ last_fetched_at: new Date().toISOString(), last_status: read.status, last_count: read.events.length }).eq('id', feed.id);
        if (statusError) console.error('[weekend/discover] feed status write failed', { feedId: feed.id, error: statusError.message });
      } catch (e) {
        console.error('[weekend/discover] feed status write threw', { feedId: feed.id, error: e instanceof Error ? e.name : 'unknown' });
      }
    };

    // The deadline bounds the feed reads, not only when they may START: a feed
    // still reading when it passes is left for the next search — counted in
    // `feedsSkipped`, its late result never used and its row left as it was,
    // so it keeps its place at the front of the next search's queue.
    const DEADLINE = Symbol('deadline');
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deadlineReached = new Promise<typeof DEADLINE>((resolve) => { deadlineTimer = setTimeout(() => resolve(DEADLINE), FEEDS_DEADLINE_MS); });
    const deadline = Date.now() + FEEDS_DEADLINE_MS;
    let next = 0;
    // A few at a time; past the deadline, the rest are left for the next search.
    const worker = async () => {
      while (next < feeds.length) {
        const feed = feeds[next++];
        if (Date.now() >= deadline) { feedsSkipped += 1; continue; }
        sourcesTried.push(`feed:${feed.label}`);
        const read = await Promise.race([fetchFeed(feed), deadlineReached]);
        if (read === DEADLINE) { feedsSkipped += 1; continue; }
        if (read.status === 'ok') {
          lists.push(read.events);
          sourcesUsed.push(`feed:${feed.label}`);
        } else {
          sourceErrors.feedsFailed = FEEDS_FAILED;
        }
        await recordFeedStatus(feed, read);
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(FEED_CONCURRENCY, feeds.length) }, worker));
    } finally {
      clearTimeout(deadlineTimer);
    }
  }
  // Left for the next search is not the same as unreachable: the planner says
  // each in its own words, keyed `feedsSkipped` and `feedsFailed`.
  if (feedsSkipped > 0) sourceErrors.feedsSkipped = 'Some of your saved local feeds were left for the next search.';

  // No sources at all → tell the user how to enable discovery (never fake data).
  if (sourcesTried.length === 0) {
    return NextResponse.json({
      error: tr('discover.noEventSourcesAreConnected'),
      needsConfig: true,
    }, { status: 503 });
  }
  // Every source tried, none answered: that is an outage, not an empty weekend.
  if (sourcesUsed.length === 0) {
    return NextResponse.json({
      error: tr('discover.eventSourcesUnreachable'),
      errors: sourceErrors,
    }, { status: 502 });
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

  // Its result used to be discarded outright — not even the error bound. Best-effort, so logged rather than raised. Audit C1-S9-76.
  const { error: weekendSearchesWriteError } = await supabase.from('weekend_searches').insert({ family_id: familyId, zip: zip.trim(), radius_miles: radiusMiles, days: windowDays, result_count: merged.length, last_run_at: new Date().toISOString(), created_by: ctx.user.id });
  if (weekendSearchesWriteError) console.error('[weekend-discover] weekend_searches insert failed', weekendSearchesWriteError);

  return NextResponse.json({ count: merged.length, zip: zip.trim(), radius: radiusMiles, days: windowDays, sources: sourcesUsed, errors: sourceErrors });
}
