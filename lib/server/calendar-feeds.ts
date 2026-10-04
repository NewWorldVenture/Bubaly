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
// it had just removed (review on #908). The claim is FENCED: a sync that lost
// its claim to a stale takeover is refused at its next write and cannot stamp
// the new holder's result (audit note of 2026-10-04 07:33 UTC). Used by both
// the dashboard server actions and the nightly cron. Accepts any Supabase
// client (RLS-scoped server client for user actions, service client for cron).

import type { SupabaseClient } from '@supabase/supabase-js';
import { parseICS } from '@/lib/sync/ics';
import { planFeedRows, seriesKeys } from '@/lib/calendar/feeds';
import { fetchPublicCalendarText } from '@/lib/server/public-calendar-fetch';
import { wroteNoRows } from '@/lib/supabase/errors';
import { readAll } from '@/lib/supabase/read-all';

export type FeedSyncResult =
  | { ok: true; imported: number }
  | {
    ok: false;
    error: string;
    /** Another sync of this feed holds it; nothing was fetched or written. Try again shortly. */
    busy?: true;
    /**
     * This sync held the feed, outlived CLAIM_STALE_MS, and another sync took
     * the claim. It stopped at its next write boundary and left the feed's
     * status to the new holder, whose snapshot is at least as new. Not a
     * failure of the feed; the cron counts it with `busy`.
     */
    takenOver?: true;
  };

/** The `last_status` a feed carries while a sync holds it. */
export const SYNCING_STATUS = 'syncing';
/**
 * How long a claim stands before another sync may take it over. A sync that
 * dies without stamping a result — a process killed mid-upsert — leaves the
 * feed `syncing`; past this the next sync treats that as abandoned. The fetch
 * times out at 15 s and the writes are chunked, so a live sync is minutes at
 * most; a worker still running at ten minutes is one the platform's own
 * function deadline should already have ended. Should one survive anyway, the
 * takeover is FENCED (see `claimFeed`): it is refused at its next write and
 * cannot stamp the new holder's result.
 */
export const CLAIM_STALE_MS = 10 * 60 * 1000;
export const BUSY_MESSAGE = 'This calendar is already being synced; try again in a moment';
export const TAKEN_OVER_MESSAGE = 'Another sync took over this calendar';

/** The outcome of writing a result onto the feed: `lost` is a fence that no longer matches. */
type Stamped = 'stamped' | 'lost' | 'failed';
type Guard = {
  /** Writes the result and releases the claim — only while this sync still holds it. */
  settle: (patch: Record<string, unknown>) => Promise<Stamped>;
  /** True while this sync's claim is still the one on the row. Asked before every write. */
  holds: () => Promise<boolean>;
  /** The result for a claim another sync has taken; this sync stops and stamps nothing. */
  lost: () => FeedSyncResult;
};

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
  const { fence } = claim;

  // Every path below settles the claim by stamping a result. A throw would not,
  // and would leave the feed held until the stale cutoff; release it as an
  // error instead, and let the throw reach the caller as before. Every stamp
  // carries the fence, so a claim another sync has since taken is never
  // overwritten — not by a result, not by this release.
  let settled = false;
  const guard: Guard = {
    settle: (patch) => { settled = true; return stampFeed(supabase, feed.id, patch, fence); },
    holds: () => holdsClaim(supabase, feed.id, fence),
    lost: () => { settled = true; return { ok: false, error: TAKEN_OVER_MESSAGE, takenOver: true }; },
  };
  try {
    return await runSync(supabase, feed, guard);
  } finally {
    if (!settled) await stampFeed(supabase, feed.id, { last_status: 'error', last_error: 'The sync did not finish' }, fence);
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
 *
 * The claim's own `updated_at`, as the row holds it after the write, is the
 * FENCE: every later write of this sync compares against it. A takeover writes
 * the row and so moves it, after which the sync that lost is refused at its
 * next write boundary (`holdsClaim`) and its stamps match nothing (`stampFeed`).
 * What it wrote before noticing stands — upserts of its own snapshot, removals
 * of what that snapshot cancelled — and the new holder's pass, over a snapshot
 * at least as new, and the next sync after it, bring the feed to the source's
 * state. The window between a holder's check and its write is the one PostgREST
 * leaves open; closing it needs the write and the check in one statement, a
 * database function this unit does not add.
 */
async function claimFeed(supabase: SupabaseClient, feedId: string): Promise<{ fence: string } | 'busy' | 'failed'> {
  const now = new Date();
  const mark = { last_status: SYNCING_STATUS, updated_at: now.toISOString() };
  const fenceOf = (rows: unknown): { fence: string } | 'failed' => {
    const row = Array.isArray(rows) ? (rows[0] as { updated_at?: unknown } | undefined) : undefined;
    if (typeof row?.updated_at !== 'string') { console.error(`Calendar feed claim for ${feedId} returned no stamp`); return 'failed'; }
    return { fence: row.updated_at };
  };
  const idle = await supabase.from('calendar_feeds').update(mark).eq('id', feedId).neq('last_status', SYNCING_STATUS).select('id, updated_at');
  if (idle.error) { console.error(`Calendar feed claim failed for ${feedId}:`, idle.error); return 'failed'; }
  if (!wroteNoRows(idle.data)) return fenceOf(idle.data);

  // Nothing idle to take: the feed is held, or is not ours to update (RLS
  // matches nothing without an error — the silence stampFeed guards against).
  const { data: held, error: readError } = await supabase.from('calendar_feeds').select('last_status, updated_at').eq('id', feedId).maybeSingle();
  if (readError || !held) { console.error(`Calendar feed claim read failed for ${feedId}:`, readError ?? 'no row'); return 'failed'; }
  if (held.last_status !== SYNCING_STATUS) {
    // Released between the attempt and this read: once more. A second miss on an
    // idle row is a row this client may not update.
    const again = await supabase.from('calendar_feeds').update(mark).eq('id', feedId).neq('last_status', SYNCING_STATUS).select('id, updated_at');
    if (again.error) { console.error(`Calendar feed claim failed for ${feedId}:`, again.error); return 'failed'; }
    return wroteNoRows(again.data) ? 'failed' : fenceOf(again.data);
  }
  const heldSince = typeof held.updated_at === 'string' ? Date.parse(held.updated_at) : NaN;
  if (Number.isNaN(heldSince) || now.getTime() - heldSince < CLAIM_STALE_MS) return 'busy';
  const cutoff = new Date(now.getTime() - CLAIM_STALE_MS).toISOString();
  const stale = await supabase.from('calendar_feeds').update(mark).eq('id', feedId).eq('last_status', SYNCING_STATUS).lt('updated_at', cutoff).select('id, updated_at');
  if (stale.error) { console.error(`Calendar feed stale-claim takeover failed for ${feedId}:`, stale.error); return 'failed'; }
  return wroteNoRows(stale.data) ? 'busy' : fenceOf(stale.data);
}

/** True while `fence` is still the claim on the row: `syncing`, stamped at exactly that instant. */
async function holdsClaim(supabase: SupabaseClient, feedId: string, fence: string): Promise<boolean> {
  const { data, error } = await supabase.from('calendar_feeds').select('last_status, updated_at').eq('id', feedId).maybeSingle();
  if (error || !data) { console.error(`Calendar feed claim check failed for ${feedId}:`, error ?? 'no row'); return false; }
  return data.last_status === SYNCING_STATUS && data.updated_at === fence;
}

async function runSync(
  supabase: SupabaseClient,
  feed: { id: string; family_id: string; url: string },
  guard: Guard,
): Promise<FeedSyncResult> {
  /** A failure, stamped on the feed — unless the claim is no longer ours, in which case the new holder's result stands. */
  const failWith = async (message: string): Promise<FeedSyncResult> => {
    const stamped = await guard.settle({ last_status: 'error', last_error: message });
    if (stamped === 'lost') return guard.lost();
    return { ok: false, error: stamped === 'failed' ? 'Calendar feed status could not be saved' : message };
  };

  let icsText: string;
  const fetched = await fetchPublicCalendarText(feed.url);
  if (!fetched.ok) return failWith(fetched.error);
  icsText = fetched.text;

  if (!icsText.includes('BEGIN:VCALENDAR')) return failWith('URL is not a valid ICS calendar');

  let rows;
  let cancelled: string[];
  let cancelledSeries: string[];
  try {
    ({ rows, cancelled, cancelledSeries } = planFeedRows(parseICS(icsText), feed.family_id, feed.id));
  } catch {
    return failWith('Could not parse the calendar');
  }

  let imported = 0;
  for (let i = 0; i < rows.length; i += 200) {
    // The fence, before every write: a claim taken over while this sync was on
    // the network, or between chunks, stops it here with nothing more written.
    if (!(await guard.holds())) return guard.lost();
    const chunk = rows.slice(i, i + 200);
    const { error } = await supabase
      .from('calendar_events')
      .upsert(chunk, { onConflict: 'feed_id,external_uid' });
    if (error) {
      console.error(`Calendar feed event upsert failed for ${feed.id}:`, error);
      return failWith('Could not save calendar events');
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
      return failWith('Could not read calendar events');
    }
    removals.push(...seriesKeys((stored ?? []).map((r) => r.external_uid).filter((k): k is string => k != null), cancelledSeries));
  }
  for (let i = 0; i < removals.length; i += 200) {
    if (!(await guard.holds())) return guard.lost();
    const chunk = removals.slice(i, i + 200);
    const { error } = await supabase
      .from('calendar_events')
      .delete()
      .eq('feed_id', feed.id)
      .in('external_uid', chunk)
      .select('id');
    if (error) {
      console.error(`Calendar feed cancellation removal failed for ${feed.id}:`, error);
      return failWith('Could not remove cancelled events');
    }
  }

  const stamped = await guard.settle({
    last_status: 'ok', last_error: null, event_count: imported,
    last_synced_at: new Date().toISOString(),
  });
  if (stamped === 'lost') return guard.lost();
  if (stamped === 'failed') return { ok: false, error: 'Calendar feed status could not be saved' };
  return { ok: true, imported };
}

/**
 * Writes a result onto the feed — only while `fence` is still the claim. The
 * compare-and-set on (`syncing`, the claim's own stamp) is what keeps a sync
 * that lost its claim from overwriting the new holder's status, or from
 * "releasing" a claim that is no longer its own.
 */
async function stampFeed(
  supabase: SupabaseClient,
  feedId: string,
  patch: Record<string, unknown>,
  fence: string,
): Promise<Stamped> {
  // `syncFeed` is called from the settings action with the USER's client as
  // well as from the cron, so RLS can make this match nothing without an error —
  // and "last synced" then never moves while the sync reports success. Zero rows
  // is the same unsaved status as an error (Audit C1-S9-68) — unless the row
  // shows the claim has moved on, which is a takeover, not a failure to save.
  const { data, error } = await supabase.from('calendar_feeds').update(patch)
    .eq('id', feedId).eq('last_status', SYNCING_STATUS).eq('updated_at', fence).select('id');
  if (error || wroteNoRows(data)) {
    if (!error) {
      const { data: row } = await supabase.from('calendar_feeds').select('last_status, updated_at').eq('id', feedId).maybeSingle();
      if (row && !(row.last_status === SYNCING_STATUS && row.updated_at === fence)) {
        console.warn(`Calendar feed ${feedId}: another sync took over this claim; its result stands`);
        return 'lost';
      }
    }
    console.error(`Calendar feed status update failed for ${feedId}:`, error ?? 'no rows updated');
    return 'failed';
  }
  return 'stamped';
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
