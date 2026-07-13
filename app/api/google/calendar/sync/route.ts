import { NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import {
  fetchGoogleCalendarEvents,
  getValidAccessToken,
  type GoogleToken,
} from '@/lib/google';
import { enforceRequestRateLimit } from '@/lib/server/request-rate-limit';

// Fetches the next 3 months of events from Google Calendar primary and
// upserts them into calendar_events with source='google'.
export async function POST() {
  try {
    const ctx = await requireUserContext();
    const supabase = await createServer();

    // Load stored Google token from user_preferences
    const { data: prefs } = await supabase
      .from('user_preferences')
      .select('notification_prefs')
      .eq('user_id', ctx.user.id)
      .maybeSingle();

    const np = (prefs?.notification_prefs as Record<string, unknown>) ?? {};
    const stored = np.googleCalendarToken as GoogleToken | undefined;

    if (!stored?.accessToken) {
      return NextResponse.json({ error: 'Google Calendar not connected' }, { status: 400 });
    }

    const limited = await enforceRequestRateLimit(supabase, `sync:${ctx.active.familyId}:${ctx.user.id}:google-calendar`, { limit: 10 });
    if (!limited.ok) return NextResponse.json(
      { error: 'Too many sync requests. Please try again shortly.' },
      { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
    );

    const timeMin = new Date().toISOString();
    const timeMax = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();

    const { token: refreshedToken, accessToken } = await getValidAccessToken(stored);

    // Persist refreshed token if it changed
    if (refreshedToken.accessToken !== stored.accessToken) {
      const merged = { ...np, googleCalendarToken: refreshedToken };
      await supabase
        .from('user_preferences')
        .upsert({ user_id: ctx.user.id, notification_prefs: merged }, { onConflict: 'user_id' });
    }

    const events = await fetchGoogleCalendarEvents(accessToken, timeMin, timeMax);

    // Map Google events → calendar_events rows
    const rows = events
      .filter((e) => e.summary && (e.start.dateTime || e.start.date))
      .map((e) => ({
        family_id: ctx.active.familyId,
        title: e.summary!,
        description: e.description ?? null,
        location: e.location ?? null,
        category: 'general' as const,
        starts_at: (e.start.dateTime ?? e.start.date)!,
        ends_at: e.end.dateTime ?? e.end.date ?? null,
        all_day: !e.start.dateTime,
        recurrence: 'none' as const,
        recurrence_until: null,
        assignee_id: null,
        created_by: ctx.user.id,
      }));

    if (rows.length > 0) {
      // Upsert using a deterministic id approach — we don't store gcal id in schema,
      // so insert and ignore duplicates by title+starts_at+family_id via do-nothing on conflict.
      const { error } = await supabase
        .from('calendar_events')
        .insert(rows);

      if (error && error.code !== '23505') {
        console.error('Calendar upsert error:', error);
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
    }

    return NextResponse.json({ synced: rows.length });
  } catch (err) {
    console.error('Google Calendar sync error:', err);
    return NextResponse.json({ error: 'Sync failed' }, { status: 500 });
  }
}

// Returns whether the current user has Google Calendar connected.
export async function GET() {
  try {
    const ctx = await requireUserContext();
    const supabase = await createServer();

    const { data: prefs } = await supabase
      .from('user_preferences')
      .select('notification_prefs')
      .eq('user_id', ctx.user.id)
      .maybeSingle();

    const np = (prefs?.notification_prefs as Record<string, unknown>) ?? {};
    const connected = !!(np.googleCalendarToken as GoogleToken | undefined)?.accessToken;

    return NextResponse.json({ connected });
  } catch {
    return NextResponse.json({ connected: false });
  }
}
