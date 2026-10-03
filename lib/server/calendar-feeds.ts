// lib/server/calendar-feeds.ts — server-side calendar feed sync.
// Fetches a subscribed ICS URL, parses it, and upserts its events into
// calendar_events keyed by (feed_id, external_uid) so re-syncing a changing
// public calendar updates rows in place instead of duplicating them, and
// removes the events the source marks cancelled. Events the source simply
// drops are NOT removed: a feed that publishes a rolling window would otherwise
// erase a family's history on every sync, and that trade-off is recorded, not
// made here. Used by
// both the dashboard server actions and the nightly cron. Accepts any Supabase
// client (RLS-scoped server client for user actions, service client for cron).

import type { SupabaseClient } from '@supabase/supabase-js';
import { parseICS } from '@/lib/sync/ics';
import { planFeedRows, type FeedEventRow } from '@/lib/calendar/feeds';
import { fetchPublicCalendarText } from '@/lib/server/public-calendar-fetch';
import { isMissingRelationError, wroteNoRows } from '@/lib/supabase/errors';

export type FeedSyncResult = { ok: true; imported: number } | { ok: false; error: string };

/**
 * Re-syncs a single feed row: fetch → parse → upsert → stamp feed metadata.
 * Always records last_status/last_error/last_synced_at on the feed so the UI
 * can show an honest state even on failure.
 */
export async function syncFeed(
  supabase: SupabaseClient,
  feed: { id: string; family_id: string; url: string },
): Promise<FeedSyncResult> {
  let icsText: string;
  const fetched = await fetchPublicCalendarText(feed.url);
  if (!fetched.ok) {
    const stampError = await stampFeed(supabase, feed.id, { last_status: 'error', last_error: fetched.error });
    if (stampError) return { ok: false, error: 'Calendar feed status could not be saved' };
    return { ok: false, error: fetched.error };
  }
  icsText = fetched.text;

  if (!icsText.includes('BEGIN:VCALENDAR')) {
    const msg = 'URL is not a valid ICS calendar';
    const stampError = await stampFeed(supabase, feed.id, { last_status: 'error', last_error: msg });
    if (stampError) return { ok: false, error: 'Calendar feed status could not be saved' };
    return { ok: false, error: msg };
  }

  let rows;
  let cancelled: string[];
  try {
    ({ rows, cancelled } = planFeedRows(parseICS(icsText), feed.family_id, feed.id));
  } catch {
    const msg = 'Could not parse the calendar';
    const stampError = await stampFeed(supabase, feed.id, { last_status: 'error', last_error: msg });
    if (stampError) return { ok: false, error: 'Calendar feed status could not be saved' };
    return { ok: false, error: msg };
  }

  let imported = 0;
  // A deploy can precede its migration. On a database without
  // `calendar_events.exception_dates` the upsert is refused for the one column
  // it does not know; the rows are then written without it — the series
  // renders every slot, as it did before the column — rather than the whole
  // feed failing to sync. Said once per sync, naming the migration.
  let withoutExceptionDates = false;
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    let { error } = await supabase
      .from('calendar_events')
      .upsert(withoutExceptionDates ? chunk.map(dropExceptionDates) : chunk, { onConflict: 'feed_id,external_uid' });
    if (error && !withoutExceptionDates && isMissingExceptionDatesColumn(error)) {
      console.warn(`Calendar feed ${feed.id}: calendar_events.exception_dates is not in this database yet (its migration has not been applied); syncing without exception dates, so a moved or cancelled occurrence still shows at its original slot.`);
      withoutExceptionDates = true;
      ({ error } = await supabase
        .from('calendar_events')
        .upsert(chunk.map(dropExceptionDates), { onConflict: 'feed_id,external_uid' }));
    }
    if (error) {
      console.error(`Calendar feed event upsert failed for ${feed.id}:`, error);
      const stampError = await stampFeed(supabase, feed.id, { last_status: 'error', last_error: 'Could not save calendar events' });
      return { ok: false, error: stampError ? 'Calendar feed status could not be saved' : 'Could not save calendar events' };
    }
    imported += chunk.length;
  }

  // What the source says is cancelled comes off the family's calendar. Scoped
  // to this feed's own rows, and only to the uids the source named: nothing
  // else of the family's is reachable from here. A key never imported deletes
  // nothing, which is the ordinary case and not a failure; `.select` confirms
  // the statement ran, not that it matched.
  for (let i = 0; i < cancelled.length; i += 200) {
    const chunk = cancelled.slice(i, i + 200);
    const { error } = await supabase
      .from('calendar_events')
      .delete()
      .eq('feed_id', feed.id)
      .in('external_uid', chunk)
      .select('id');
    if (error) {
      console.error(`Calendar feed cancellation removal failed for ${feed.id}:`, error);
      const stampError = await stampFeed(supabase, feed.id, { last_status: 'error', last_error: 'Could not remove cancelled events' });
      return { ok: false, error: stampError ? 'Calendar feed status could not be saved' : 'Could not remove cancelled events' };
    }
  }

  const stampError = await stampFeed(supabase, feed.id, {
    last_status: 'ok', last_error: null, event_count: imported,
    last_synced_at: new Date().toISOString(),
  });
  if (stampError) return { ok: false, error: 'Calendar feed status could not be saved' };
  return { ok: true, imported };
}

/** The row as a database without the `exception_dates` column accepts it. */
function dropExceptionDates(row: FeedEventRow): Omit<FeedEventRow, 'exception_dates'> {
  const copy: Partial<FeedEventRow> = { ...row };
  delete copy.exception_dates;
  return copy as Omit<FeedEventRow, 'exception_dates'>;
}

/** PostgREST (PGRST204) or Postgres (42703) refusing the one column this database does not have yet. */
function isMissingExceptionDatesColumn(error: unknown): boolean {
  const message = typeof error === 'object' && error && 'message' in error ? String((error as { message: unknown }).message) : '';
  return isMissingRelationError(error) && /exception_dates/i.test(message);
}

async function stampFeed(
  supabase: SupabaseClient,
  feedId: string,
  patch: Record<string, unknown>,
): Promise<Error | null> {
  // `syncFeed` is called from the settings action with the USER's client as
  // well as from the cron, so RLS can make this match nothing without an error —
  // and "last synced" then never moves while the sync reports success. Zero rows
  // is the same unsaved status as an error. Audit C1-S9-68.
  const { data, error } = await supabase.from('calendar_feeds').update(patch).eq('id', feedId).select('id');
  if (error || wroteNoRows(data)) {
    console.error(`Calendar feed status update failed for ${feedId}:`, error ?? 'no rows updated');
    return new Error('Calendar feed status update failed');
  }
  return null;
}

/** Re-syncs every feed for a family (used after add, and by cron per-family). */
export async function syncAllFeedsForFamily(
  supabase: SupabaseClient,
  familyId: string,
): Promise<{ feeds: number; imported: number }> {
  const { data: feeds } = await supabase
    .from('calendar_feeds')
    .select('id, family_id, url')
    .eq('family_id', familyId);

  let imported = 0;
  for (const f of feeds ?? []) {
    const r = await syncFeed(supabase, f as { id: string; family_id: string; url: string });
    if (r.ok) imported += r.imported;
  }
  return { feeds: (feeds ?? []).length, imported };
}
