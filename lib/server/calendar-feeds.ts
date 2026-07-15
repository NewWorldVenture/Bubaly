// lib/server/calendar-feeds.ts — server-side calendar feed sync.
// Fetches a subscribed ICS URL, parses it, and upserts its events into
// calendar_events keyed by (feed_id, external_uid) so re-syncing a changing
// public calendar updates rows in place instead of duplicating them. Used by
// both the dashboard server actions and the nightly cron. Accepts any Supabase
// client (RLS-scoped server client for user actions, service client for cron).

import type { SupabaseClient } from '@supabase/supabase-js';
import { parseICS } from '@/lib/sync/ics';
import { buildFeedRows } from '@/lib/calendar/feeds';
import { fetchPublicCalendarText } from '@/lib/server/public-calendar-fetch';

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
  try {
    rows = buildFeedRows(parseICS(icsText), feed.family_id, feed.id);
  } catch {
    const msg = 'Could not parse the calendar';
    const stampError = await stampFeed(supabase, feed.id, { last_status: 'error', last_error: msg });
    if (stampError) return { ok: false, error: 'Calendar feed status could not be saved' };
    return { ok: false, error: msg };
  }

  let imported = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const { error } = await supabase
      .from('calendar_events')
      .upsert(chunk, { onConflict: 'feed_id,external_uid' });
    if (error) {
      console.error(`Calendar feed event upsert failed for ${feed.id}:`, error);
      const stampError = await stampFeed(supabase, feed.id, { last_status: 'error', last_error: 'Could not save calendar events' });
      return { ok: false, error: stampError ? 'Calendar feed status could not be saved' : 'Could not save calendar events' };
    }
    imported += chunk.length;
  }

  const stampError = await stampFeed(supabase, feed.id, {
    last_status: 'ok', last_error: null, event_count: imported,
    last_synced_at: new Date().toISOString(),
  });
  if (stampError) return { ok: false, error: 'Calendar feed status could not be saved' };
  return { ok: true, imported };
}

async function stampFeed(
  supabase: SupabaseClient,
  feedId: string,
  patch: Record<string, unknown>,
): Promise<Error | null> {
  const { error } = await supabase.from('calendar_feeds').update(patch).eq('id', feedId);
  if (error) {
    console.error(`Calendar feed status update failed for ${feedId}:`, error);
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
