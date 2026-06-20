import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { generateICS, type IcsEvent } from '@/lib/sync/ics';

// Public iCalendar feed for a single theagoras calendar.
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
  if (!token || token.length < 16) {
    return new NextResponse('Not found', { status: 404 });
  }

  const supabase = createServiceClient();

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
  const { data: rows } = await supabase
    .from('sync_calendar_events')
    .select('id, uid, title, description, location, starts_at, ends_at, all_day, recurrence_rule, status, updated_at')
    .eq('calendar_id', calendar.id)
    .is('deleted_at', null)
    .lte('starts_at', horizon)
    .order('starts_at', { ascending: true })
    .limit(2000);

  const events: IcsEvent[] = (rows ?? []).map((e) => ({
    uid: e.uid ?? `${e.id}@theagoras.com`,
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
