// lib/server/calendar-feeds.ts — server-side calendar feed sync.
// Fetches a subscribed ICS URL, parses it, and upserts its events into
// calendar_events keyed by (feed_id, external_uid) so re-syncing a changing
// public calendar updates rows in place instead of duplicating them. Used by
// both the dashboard server actions and the nightly cron. Accepts any Supabase
// client (RLS-scoped server client for user actions, service client for cron).

import type { SupabaseClient } from '@supabase/supabase-js';
import { parseICS } from '@/lib/sync/ics';
import { buildFeedRows, normalizeFeedUrl } from '@/lib/calendar/feeds';

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
  const url = normalizeFeedUrl(feed.url);
  if (!url) {
    await stampFeed(supabase, feed.id, { last_status: 'error', last_error: 'Invalid calendar URL' });
    return { ok: false, error: 'Invalid calendar URL' };
  }

  let icsText: string;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Bubaly-Calendar-Sync/1.0', Accept: 'text/calendar, text/plain, */*' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const msg = `Feed returned HTTP ${res.status}`;
      await stampFeed(supabase, feed.id, { last_status: 'error', last_error: msg });
      return { ok: false, error: msg };
    }
    icsText = await res.text();
  } catch {
    const msg = 'Could not reach the calendar URL';
    await stampFeed(supabase, feed.id, { last_status: 'error', last_error: msg });
    return { ok: false, error: msg };
  }

  if (!icsText.includes('BEGIN:VCALENDAR')) {
    const msg = 'URL is not a valid ICS calendar';
    await stampFeed(supabase, feed.id, { last_status: 'error', last_error: msg });
    return { ok: false, error: msg };
  }

  let rows;
  try {
    rows = buildFeedRows(parseICS(icsText), feed.family_id, feed.id);
  } catch {
    const msg = 'Could not parse the calendar';
    await stampFeed(supabase, feed.id, { last_status: 'error', last_error: msg });
    return { ok: false, error: msg };
  }

  let imported = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200);
    const { error } = await supabase
      .from('calendar_events')
      .upsert(chunk, { onConflict: 'feed_id,external_uid' });
    if (!error) imported += chunk.length;
  }

  await stampFeed(supabase, feed.id, {
    last_status: 'ok', last_error: null, event_count: imported,
    last_synced_at: new Date().toISOString(),
  });
  return { ok: true, imported };
}

async function stampFeed(
  supabase: SupabaseClient,
  feedId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await supabase.from('calendar_feeds').update(patch).eq('id', feedId);
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
