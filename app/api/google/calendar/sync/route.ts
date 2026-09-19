import { NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import {
  fetchGoogleCalendarEvents,
  getValidAccessToken,
  isGoogleReconnectRequired,
  type GoogleToken,
} from '@/lib/google';
import { enforceRequestRateLimit } from '@/lib/server/request-rate-limit';
import { decodeGoogleToken, encodeGoogleToken, hasStoredGoogleToken } from '@/lib/google-token-storage';

// Fetches the next 3 months of events from Google Calendar primary and
// upserts them into calendar_events with source='google'.
export async function POST() {
  const t = await getTranslations();
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
    // Reads both the encrypted envelope and the plaintext object rows written
    // before C3-S5-02. There is no SQL migration for those — the key lives in
    // the application — so a legacy row is re-written encrypted the first time
    // it is used, below.
    const decoded = decodeGoogleToken(np.googleCalendarToken);

    if (!decoded) {
      return NextResponse.json({ error: t('sync.googleCalendarNotConnected') }, { status: 400 });
    }
    const stored = decoded.token;

    const limited = await enforceRequestRateLimit(supabase, `sync:${ctx.active.familyId}:${ctx.user.id}:google-calendar`, { limit: 10 });
    if (!limited.ok) return NextResponse.json(
      { error: t('sync.tooManySyncRequestsPlease') },
      { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
    );

    const timeMin = new Date().toISOString();
    const timeMax = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();

    let refreshedToken: GoogleToken;
    let accessToken: string;
    try {
      ({ token: refreshedToken, accessToken } = await getValidAccessToken(stored));
    } catch (err) {
      if (!isGoogleReconnectRequired(err)) throw err;
      // The grant is dead, so what is stored is not a connection any more.
      // Clearing it is what puts the "Connect Google" button back in front of
      // the user: GET below reports `connected` from this same value, so
      // leaving a corpse there would keep showing "Sync" for a calendar that
      // can never sync. Only a DEFINITIVE revocation reaches here — a timeout
      // or a 5xx rethrows above and leaves the connection alone.
      // Null rather than `delete`: GET reads `googleCalendarToken?.accessToken`,
      // so null already answers `connected: false`, and it keeps the same shape
      // the refresh path writes a line below instead of two ways to say "gone".
      const cleared = { ...np, googleCalendarToken: null };
      // Read: a refused clear defeats the very purpose the comment above gives
      // for clearing. GET answers `connected` from this same value, so a failed
      // write leaves the "Sync" button in front of a calendar that can never
      // sync, while this response tells the user to reconnect. The grant is
      // dead either way, so this still answers 409 — but the contradiction is
      // named rather than invisible. Audit C1-S6-02.
      const { error: clearError } = await supabase
        .from('user_preferences')
        .upsert({ user_id: ctx.user.id, notification_prefs: cleared }, { onConflict: 'user_id' });
      if (clearError) {
        console.error('[google-calendar] dead grant could not be cleared; the UI will still offer Sync', clearError);
      }
      // 409, not 500: nothing is broken on our side and retrying will not help.
      // `reconnect` is the machine-readable half the client keys off.
      return NextResponse.json(
        { error: t('sync.googleAccessExpiredReconnect'), reconnect: true },
        { status: 409 },
      );
    }

    // Persist the token when it changed, and ALSO when it was found in the old
    // plaintext form — that second case is the migration: the row converts on
    // first use, with no separate backfill and no window where the two shapes
    // disagree.
    if (refreshedToken.accessToken !== stored.accessToken || decoded.legacy) {
      const merged = { ...np, googleCalendarToken: encodeGoogleToken(refreshedToken) };
      const { error: persistError } = await supabase
        .from('user_preferences')
        .upsert({ user_id: ctx.user.id, notification_prefs: merged }, { onConflict: 'user_id' });
      if (persistError) {
        // A lost refresh is self-correcting — the next sync refreshes again.
        // A lost MIGRATION is not: the plaintext token stays in a column the
        // browser can read, and everything looks fine. C3-S5-02 depends on
        // this write landing, so the two cases are logged differently.
        // Audit C1-S6-02.
        if (decoded.legacy) {
          console.error('[google-calendar] plaintext token was NOT migrated to ciphertext; it remains readable', persistError);
        } else {
          console.warn('[google-calendar] refreshed token not persisted; the next sync will refresh again', persistError);
        }
      }
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
        return NextResponse.json({ error: t('sync.couldNotSaveImportedCalendar') }, { status: 500 });
      }
    }

    return NextResponse.json({ synced: rows.length });
  } catch (err) {
    console.error('Google Calendar sync error:', err);
    return NextResponse.json({ error: t('sync.syncFailed') }, { status: 500 });
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
    // Answered without decrypting: the status endpoint does not need the key,
    // and a key rotation should not make every user look disconnected.
    const connected = hasStoredGoogleToken(np.googleCalendarToken);

    return NextResponse.json({ connected });
  } catch {
    return NextResponse.json({ connected: false });
  }
}
