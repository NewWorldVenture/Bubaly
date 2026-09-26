import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { generateICS, type IcsEvent } from '@/lib/sync/ics';
import { isValidFeedToken } from '@/lib/sync/feed-request';
import { clientIp, rateLimit } from '@/lib/server/rate-limit';
import { rateLimitDb } from '@/lib/server/rate-limit-db';
import { readAll } from '@/lib/supabase/read-all';

// Public iCalendar feed for a single bubaly calendar.
//
//   GET /api/sync/feeds/<feed_token>
//
// The feed_token is an unguessable capability slug (see lib/sync/feed-token.ts):
// holding it grants read access to this one calendar's events, which is exactly
// what calendar clients need to subscribe. Apple Calendar, Outlook, Google
// ("From URL"), and Alexa can all subscribe to this URL and receive updates.
// No OAuth, no login — that is the point. Revoke by rotating feed_token or
// setting feed_enabled = false.
//
// Uses the service client because the request is unauthenticated by design; the
// token IS the authorization, and we scope strictly to feed_enabled rows.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  if (!isValidFeedToken(token)) {
    return new NextResponse('Not found', { status: 404 });
  }

  const supabase = createServiceClient();
  const key = `sync-feed:${clientIp(_req.headers)}`;
  const limited = rateLimit(key, { limit: 60, windowMs: 60_000 });
  if (!limited.ok) return new NextResponse('Too many requests', {
    status: 429,
    headers: { 'Retry-After': String(limited.retryAfter) },
  });
  const durable = await rateLimitDb(supabase, key, { limit: 60, windowMs: 60_000 });
  if (!durable.ok) return new NextResponse('Too many requests', {
    status: 429,
    headers: { 'Retry-After': String(durable.retryAfter) },
  });

  const { data: calendar, error } = await supabase
    .from('sync_calendars')
    .select('id, name, description, timezone, feed_enabled')
    .eq('feed_token', token)
    .eq('feed_enabled', true)
    .maybeSingle();

  if (error || !calendar) {
    return new NextResponse('Not found', { status: 404 });
  }

  // Pull the next ~13 months of non-deleted events (subscribers re-poll).
  const horizon = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000).toISOString();
  // `.limit(2000)` is not a bound — PostgREST caps a response at db-max-rows
  // whatever the client asked for, so a busy calendar published 1,000 events and
  // called that the feed. `id` breaks ties so two pages cannot overlap or skip.
  const { rows, error: rowsError } = await readAll((from, to) => supabase
    .from('sync_calendar_events')
    .select('id, uid, title, description, location, starts_at, ends_at, all_day, recurrence_rule, status, updated_at')
    .eq('calendar_id', calendar.id)
    .is('deleted_at', null)
    .lte('starts_at', horizon)
    .order('starts_at', { ascending: true })
    .order('id')
    .range(from, to), { max: 2000 });

  // An iCalendar feed is not a list — it is the subscriber's COPY. Apple
  // Calendar, Outlook and Google reconcile their local store against this body,
  // so an event missing from it is an event DELETED from the person's device.
  //
  // readAll reports a truncated or failed read as an error while `rows` still
  // holds the partial set, and this route destructured only `rows` — so a
  // transient database failure, or a calendar busier than the 2,000 ceiling,
  // published a short feed at HTTP 200 and quietly removed the remainder from
  // every device subscribed to it.
  //
  // 5xx is the correct answer and is strictly better than a partial 200: every
  // calendar client treats a failed fetch by KEEPING what it already has and
  // retrying later. Audit C4-S4-06.
  if (rowsError) {
    console.error('[sync-feed] event read failed or truncated; refusing to publish a partial calendar', {
      calendarId: calendar.id, error: rowsError,
    });
    return new NextResponse('Calendar temporarily unavailable', {
      status: 503,
      headers: { 'Retry-After': '300', 'Cache-Control': 'no-store' },
    });
  }

  const events: IcsEvent[] = (rows ?? []).map((e) => ({
    uid: e.uid ?? `${e.id}@bubaly.com`,
    title: e.title,
    description: e.description,
    location: e.location,
    startsAt: e.starts_at,
    endsAt: e.ends_at,
    allDay: e.all_day,
    recurrenceRule: e.recurrence_rule,
    updatedAt: e.updated_at,
    status: (e.status as IcsEvent['status']) ?? 'confirmed',
  }));

  const body = generateICS(events, {
    name: calendar.name,
    description: calendar.description ?? undefined,
    timezone: calendar.timezone,
    dtstamp: new Date().toISOString(),
    refreshIntervalMins: 60,
  });

  return new NextResponse(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `inline; filename="${calendar.id}.ics"`,
      'Cache-Control': 'public, max-age=900, s-maxage=900',
    },
  });
}
