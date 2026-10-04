// lib/server/calendar-feeds.ts — server-side calendar feed sync.
// Fetches a subscribed ICS URL, parses it, and upserts its events into
// calendar_events keyed by (feed_id, external_uid) so re-syncing a changing
// public calendar updates rows in place instead of duplicating them, and
// removes the events the source marks cancelled. Events the source simply
// drops are NOT removed: a feed that publishes a rolling window would otherwise
// erase a family's history on every sync, and that trade-off is recorded, not
// made here. One sync of a feed runs at a time (`claimFeed`): the nightly cron
// and a member's "Sync now" could otherwise interleave, and the one holding the
// OLDER snapshot delete what the newer one had just written, or write back what
// it had just removed (review on #908). Used by both the dashboard server
// actions and the nightly cron. Accepts any Supabase client (RLS-scoped server
// client for user actions, service client for cron).

import type { SupabaseClient } from '@supabase/supabase-js';
import { parseICS } from '@/lib/sync/ics';
import { planFeedRows, seriesKeys } from '@/lib/calendar/feeds';
import { fetchPublicCalendarText } from '@/lib/server/public-calendar-fetch';
import { wroteNoRows } from '@/lib/supabase/errors';
import { readAll } from '@/lib/supabase/read-all';

export type FeedSyncResult =
  | { ok: true; imported: number }
  /** `busy`: another sync of this feed holds it; nothing was fetched or written. Try again shortly. */
  | { ok: false; error: string; busy?: true };

/** The `last_status` a feed carries while a sync holds it. */
export const SYNCING_STATUS = 'syncing';
/**
 * How long a claim stands before another sync may take it over. A sync that
 * dies without stamping a result — a process killed mid-upsert — leaves the
 * feed `syncing`; past this the next sync treats that as abandoned. The fetch
 * times out at 15 s and the writes are chunked, so a live sync is minutes at
 * most.
 */
export const CLAIM_STALE_MS = 10 * 60 * 1000;
export const BUSY_MESSAGE = 'This calendar is already being synced; try again in a moment';

type Settle = (patch: Record<string, unknown>) => Promise<Error | null>;

/**
 * Re-syncs a single feed row: claim → fetch → parse → upsert → remove what the
 * source cancelled → stamp feed metadata. Always records
 * last_status/last_error/last_synced_at on the feed so the UI can show an
 * honest state even on failure — and that stamp is what releases the claim.
 */
export async function syncFeed(
  supabase: SupabaseClient,
  feed: { id: string; family_id: string; url: string },
): Promise<FeedSyncResult> {
  const claim = await claimFeed(supabase, feed.id);
  if (claim === 'busy') return { ok: false, error: BUSY_MESSAGE, busy: true };
  if (claim === 'failed') return { ok: false, error: 'Calendar feed status could not be saved' };

  // Every path below settles the claim by stamping a result. A throw would not,
  // and would leave the feed held until the stale cutoff; release it as an
  // error instead, and let the throw reach the caller as before.
  let settled = false;
  const settle: Settle = (patch) => { settled = true; return stampFeed(supabase, feed.id, patch); };
  try {
    return await runSync(supabase, feed, settle);
  } finally {
    if (!settled) await stampFeed(supabase, feed.id, { last_status: 'error', last_error: 'The sync did not finish' });
  }
}

/**
 * Takes the feed for this sync, or reports who has it. `last_status` doubles as
 * the claim: a compare-and-set to `syncing` on a feed that is not already
 * `syncing` wins exactly once under concurrent updates of the one row. A feed
 * found `syncing` is busy — unless its claim is older than CLAIM_STALE_MS, the
 * mark of a sync that died, which the next sync takes over with the same
 * compare-and-set on the stale timestamp. No new column: `updated_at` (kept by
 * the table's trigger, and written here too so the claim's age is explicit)
 * dates the claim, and the result stamp that ends every sync releases it.
 */
async function claimFeed(supabase: SupabaseClient, feedId: string): Promise<'claimed' | 'busy' | 'failed'> {
  const now = new Date();
  const mark = { last_status: SYNCING_STATUS, updated_at: now.toISOString() };
  const idle = await supabase.from('calendar_feeds').update(mark).eq('id', feedId).neq('last_status', SYNCING_STATUS).select('id');
  if (idle.error) { console.error(`Calendar feed claim failed for ${feedId}:`, idle.error); return 'failed'; }
  if (!wroteNoRows(idle.data)) return 'claimed';

  // Nothing idle to take: the feed is held, or is not ours to update (RLS
  // matches nothing without an error — the silence stampFeed guards against).
  const { data: held, error: readError } = await supabase.from('calendar_feeds').select('last_status, updated_at').eq('id', feedId).maybeSingle();
  if (readError || !held) { console.error(`Calendar feed claim read failed for ${feedId}:`, readError ?? 'no row'); return 'failed'; }
  if (held.last_status !== SYNCING_STATUS) {
    // Released between the attempt and this read: once more. A second miss on an
    // idle row is a row this client may not update.
    const again = await supabase.from('calendar_feeds').update(mark).eq('id', feedId).neq('last_status', SYNCING_STATUS).select('id');
    if (again.error) { console.error(`Calendar feed claim failed for ${feedId}:`, again.error); return 'failed'; }
    return wroteNoRows(again.data) ? 'failed' : 'claimed';
  }
  const heldSince = typeof held.updated_at === 'string' ? Date.parse(held.updated_at) : NaN;
  if (Number.isNaN(heldSince) || now.getTime() - heldSince < CLAIM_STALE_MS) return 'busy';
  const cutoff = new Date(now.getTime() - CLAIM_STALE_MS).toISOString();
  const stale = await supabase.from('calendar_feeds').update(mark).eq('id', feedId).eq('last_status', SYNCING_STATUS).lt('updated_at', cutoff).select('id');
  if (stale.error) { console.error(`Calendar feed stale-claim takeover failed for ${feedId}:`, stale.error); return 'failed'; }
  return wroteNoRows(stale.data) ? 'busy' : 'claimed';
}

async function runSync(
  supabase: SupabaseClient,
  feed: { id: string; family_id: string; url: string },
  settle: Settle,
): Promise<FeedSyncResult> {
  let icsText: string;
  const fetched = await fetchPublicCalendarText(feed.url);
  if (!fetched.ok) {
    const stampError = await settle({ last_status: 'error', last_error: fetched.error });
    if (stampError) return { ok: false, error: 'Calendar feed status could not be saved' };
    return { ok: false, error: fetched.error };
  }
  icsText = fetched.text;

  if (!icsText.includes('BEGIN:VCALENDAR')) {
    const msg = 'URL is not a valid ICS calendar';
    const stampError = await settle({ last_status: 'error', last_error: msg });
    if (stampError) return { ok: false, error: 'Calendar feed status could not be saved' };
    return { ok: false, error: msg };
  }

  let rows;
  let cancelled: string[];
  let cancelledSeries: string[];
  try {
    ({ rows, cancelled, cancelledSeries } = planFeedRows(parseICS(icsText), feed.family_id, feed.id));
  } catch {
    const msg = 'Could not parse the calendar';
    const stampError = await settle({ last_status: 'error', last_error: msg });
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
      const stampError = await settle({ last_status: 'error', last_error: 'Could not save calendar events' });
      return { ok: false, error: stampError ? 'Calendar feed status could not be saved' : 'Could not save calendar events' };
    }
    imported += chunk.length;
  }

  // What the source says is cancelled comes off the family's calendar. Scoped
  // to this feed's own rows, and only to the keys the source named: nothing
  // else of the family's is reachable from here. A key never imported deletes
  // nothing, which is the ordinary case and not a failure; `.select` confirms
  // the statement ran, not that it matched.
  //
  // A cancelled MASTER names its whole series, and the plan cannot list the
  // exception rows an earlier sync imported: their keys carry RECURRENCE-IDs
  // this snapshot no longer publishes. Read this feed's stored keys and take
  // the ones under each cancelled UID (`seriesKeys`), then remove by exact key
  // like any other cancellation. Not a pattern match — a UID may carry LIKE's
  // own wildcards — and only on the rare sync that cancels a master.
  const removals = [...cancelled];
  if (cancelledSeries.length) {
    const { rows: stored, error } = await readAll<{ external_uid: string | null }>((from, to) => supabase
      .from('calendar_events')
      .select('external_uid')
      .eq('feed_id', feed.id)
      .order('id')
      .range(from, to));
    if (error) {
      console.error(`Calendar feed key read failed for ${feed.id}:`, error);
      const stampError = await settle({ last_status: 'error', last_error: 'Could not read calendar events' });
      return { ok: false, error: stampError ? 'Calendar feed status could not be saved' : 'Could not read calendar events' };
    }
    removals.push(...seriesKeys((stored ?? []).map((r) => r.external_uid).filter((k): k is string => k != null), cancelledSeries));
  }
  for (let i = 0; i < removals.length; i += 200) {
    const chunk = removals.slice(i, i + 200);
    const { error } = await supabase
      .from('calendar_events')
      .delete()
      .eq('feed_id', feed.id)
      .in('external_uid', chunk)
      .select('id');
    if (error) {
      console.error(`Calendar feed cancellation removal failed for ${feed.id}:`, error);
      const stampError = await settle({ last_status: 'error', last_error: 'Could not remove cancelled events' });
      return { ok: false, error: stampError ? 'Calendar feed status could not be saved' : 'Could not remove cancelled events' };
    }
  }

  const stampError = await settle({
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
