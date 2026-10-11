// lib/server/calendar-feeds.ts — server-side calendar feed sync.
// With the held source capability enabled, publishes complete raw UID groups
// atomically through the archive RPC. The default legacy path upserts events into
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
// the new holder's result (audit note of 2026-10-04 07:33 UTC). On a database
// without held migration 0490 the writes fall back to what production did
// before it (`legacyApplyChunk`). Used by both
// the dashboard server actions and the nightly cron. Accepts any Supabase
// client (RLS-scoped server client for user actions, service client for cron).

import type { SupabaseClient } from '@supabase/supabase-js';
import { parseICS, UnsupportedIcsRecurrenceError, type IcsEvent } from '@/lib/sync/ics';
import { assertFeedRecurrenceAdmission, planFeedRows, seriesKeys, type FeedEventRow } from '@/lib/calendar/feeds';
import { fetchPublicCalendarText } from '@/lib/server/public-calendar-fetch';
import { wroteNoRows } from '@/lib/supabase/errors';
import { readCountedRows } from '@/lib/calendar/occurrences';
import { CALENDAR_SOURCE_ARCHIVE_ENABLED } from '@/lib/calendar/source-capability';
import { parseICSSource } from '@/lib/sync/ics-source';
import { exportICSSource } from '@/lib/sync/ics-source-export';
import type { ImportedSourceDocument } from '@/lib/calendar/imported-source';

export type FeedSyncResult =
  | {
    ok: true;
    /** Native event rows written; source archives write none. */
    imported: number;
    /** Archived UID groups, never an event or occurrence count. */
    sourceGroups?: number;
  }
  | {
    ok: false;
    error: string;
    /** Archived UID groups, never an event or occurrence count. */
    sourceGroups?: number;
    revisionReview?: true;
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
  /** The result for a claim another sync has taken; this sync stops and stamps nothing. */
  lost: () => FeedSyncResult;
  /** Writes one chunk — upserts and removals — only while this sync holds the claim (see applyChunk). */
  apply: (upserts: FeedEventRow[], removals: string[]) => Promise<Applied>;
  archive: (documents: ImportedSourceDocument[]) => Promise<Archived>;
  /** True once this sync found 0490's function missing and writes the pre-0490 way. */
  legacy: () => boolean;
};

/** The outcome of writing a chunk: `lost` is a fence that no longer matched at the moment of the write. */
type Applied = 'applied' | 'lost' | { failed: string };
type Archived = 'applied' | 'needs_revision_review' | 'lost' | { failed: string };
export const ARCHIVE_SYNC_FUNCTION = 'calendar_feed_archive_sources';
/**
 * The database function migration 0490 adds. 0490 is RESERVED and HELD: the
 * file is in supabase/reserved/, not supabase/migrations/, until 0475-0489
 * land (the migration audit refuses a skipped number). Until it is applied a
 * database answers PGRST202 / 42883 naming the RPC, and the sync writes events
 * the way production did before it (`legacyApplyChunk`). Once it exists the
 * RPC is used unchanged; absence is probed on every sync, never remembered.
 */
export const APPLY_SYNC_FUNCTION = 'calendar_feed_apply_sync';
export const APPLY_SYNC_MIGRATION = '0490_a_calendar_feed_sync_writes_only_while_it_holds_its_claim.sql';
let warnedMissingApply = false;
let warnedMissingArchive = false;
/** Tests only: the missing-function warning is said once per process, and a test needs to hear it. */
export function resetApplySyncWarningForTests(): void { warnedMissingApply = false; warnedMissingArchive = false; }

/**
 * True only for the database's answer that the function `name` itself does not
 * exist: PGRST202 (schema cache) or 42883 (Postgres), naming `name` — bare or
 * `public.`-qualified — in the message or details. Not the hint: PostgREST's
 * is "Perhaps you meant …", a near match, so a 0490 applied with another
 * signature fails instead of falling back. A 42883 about another
 * function (a helper the RPC calls), a permission error, a network failure or
 * a constraint is the failure it is, never a missing migration.
 */
export function isMissingNamedFunction(error: unknown, name: string): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, message, details } = error as { code?: unknown; message?: unknown; details?: unknown };
  if (code !== 'PGRST202' && code !== '42883') return false;
  const named = new RegExp(`(?:^|[^A-Za-z0-9_.]|(?<![A-Za-z0-9_])public\\.)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`);
  return [message, details].some((text) => typeof text === 'string' && named.test(text));
}

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
  const mode = { legacy: false };
  const guard: Guard = {
    settle: (patch) => { settled = true; return stampFeed(supabase, feed.id, patch, fence); },
    lost: () => { settled = true; return { ok: false, error: TAKEN_OVER_MESSAGE, takenOver: true }; },
    apply: (upserts, removals) => applyChunk(supabase, feed.id, fence, upserts, removals, mode),
    legacy: () => mode.legacy,
    archive: async (documents) => {
      const result = await archiveSources(supabase, feed.id, fence, documents);
      // Archive publication settles status and advances the fence atomically.
      // Never overwrite that settlement with a second client-side stamp.
      if (typeof result === 'string') settled = true;
      return result;
    },
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
 * next write boundary and its stamps match nothing (`stampFeed`).
 * What it wrote before noticing stands — upserts of its own snapshot, removals
 * of what that snapshot cancelled — and the new holder's pass, over a snapshot
 * at least as new, and the next sync after it, bring the feed to the source's
 * state. The check and the write are ONE transaction where 0490's
 * `calendar_feed_apply_sync` exists (applyChunk): the function locks the feed
 * row, requires the fence, and only then writes. Without it the sync checks
 * the fence by reading the row before each chunk (`legacyApplyChunk`): not
 * atomic — a takeover can land between that read and the write — but no
 * weaker than the unclaimed writes production made before 0490.
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

  if (CALENDAR_SOURCE_ARCHIVE_ENABLED) {
    let documents: ImportedSourceDocument[];
    try {
      documents = parseICSSource(icsText);
      // Qualify every complete raw/typed group before the single atomic write.
      // This preserves source semantics; it does not claim occurrence readiness.
      for (const document of documents) exportICSSource(document);
      if (documents.length > 2000 || new TextEncoder().encode(JSON.stringify(documents)).length > 8 * 1024 * 1024) {
        return failWith('Calendar source publication limit exceeded');
      }
    } catch {
      return failWith('Could not preserve the complete calendar source');
    }
    const archived = await guard.archive(documents);
    if (archived === 'lost') return guard.lost();
    if (archived === 'needs_revision_review') {
      return { ok: false, error: 'Calendar source revisions require review before display', revisionReview: true, sourceGroups: documents.length };
    }
    if (archived !== 'applied') return failWith(archived.failed);
    return { ok: true, imported: 0, sourceGroups: documents.length };
  }

  let events: IcsEvent[];
  let rows;
  let cancelled: string[];
  let cancelledSeries: string[];
  try {
    events = parseICS(icsText, { bareCancellations: true, validateEvent: assertFeedRecurrenceAdmission });
    ({ rows, cancelled, cancelledSeries } = planFeedRows(events, feed.family_id, feed.id));
  } catch (error) {
    return failWith(error instanceof UnsupportedIcsRecurrenceError ? error.message : 'Could not parse the calendar');
  }

  let imported = 0;
  for (let i = 0; i < rows.length; i += 200) {
    // Every chunk is written under the fence: a claim taken over while this
    // sync was on the network, or between chunks, stops it here with nothing
    // more written (applyChunk).
    const chunk = rows.slice(i, i + 200);
    const applied = await guard.apply(chunk, []);
    if (applied === 'lost') return guard.lost();
    if (applied !== 'applied') {
      console.error(`Calendar feed event upsert failed for ${feed.id}:`, applied.failed);
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
  //
  // Without 0490 nothing is removed, as before it (`legacyApplyChunk`): a
  // delete the fence cannot hold to its snapshot could take what a newer sync
  // had just written.
  const removals = guard.legacy() ? [] : [...cancelled];
  if (cancelledSeries.length && !guard.legacy()) {
    const keysQuery = () => supabase.from('calendar_events')
      .select('id, external_uid', { count: 'exact' }).eq('feed_id', feed.id).order('id');
    const { data: stored, error } = await readCountedRows(
      () => keysQuery().limit(1000), (from, to) => keysQuery().range(from, to), 20_000, 'feed event keys');
    if (error) {
      console.error(`Calendar feed key read failed for ${feed.id}:`, error);
      return failWith('Could not read calendar events');
    }
    removals.push(...seriesKeys(((stored ?? []) as { external_uid: string | null }[]).map((r) => r.external_uid).filter((k): k is string => k != null), cancelledSeries));
  }
  for (let i = 0; i < removals.length; i += 200) {
    const chunk = removals.slice(i, i + 200);
    const applied = await guard.apply([], chunk);
    if (applied === 'lost') return guard.lost();
    if (applied !== 'applied') {
      console.error(`Calendar feed cancellation removal failed for ${feed.id}:`, applied.failed);
      return failWith('Could not remove cancelled events');
    }
  }

  // Without 0490, a cancelled event that carries a start is written like any
  // other, as production did before it: its buildFeedRows never read STATUS
  // (and a bare cancellation, with no start, was never parsed), so planning
  // the snapshot with STATUS ignored gives what it wrote, on today's keys.
  // Only what the feed admits as a live event: a cancelled timed series passed
  // admission because it was a removal, and is not written as a live series.
  // Known only once a chunk has asked for the function, so a snapshot of
  // nothing but cancellations this feed never stored asks nothing and writes
  // nothing — the with-0490 path makes no call there either.
  if (guard.legacy()) {
    const written = new Set(rows.map((r) => r.external_uid));
    const asBefore = planFeedRows(events.map((ev) => ({ ...ev, status: undefined })).filter(admitted), feed.family_id, feed.id)
      .rows.filter((r) => !written.has(r.external_uid));
    for (let i = 0; i < asBefore.length; i += 200) {
      const chunk = asBefore.slice(i, i + 200);
      const applied = await guard.apply(chunk, []);
      if (applied === 'lost') return guard.lost();
      if (applied !== 'applied') {
        console.error(`Calendar feed event upsert failed for ${feed.id}:`, applied.failed);
        return failWith('Could not save calendar events');
      }
      imported += chunk.length;
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

/** Archive only through the locked claim RPC; never use legacy projections as fallback. */
async function archiveSources(
  supabase: SupabaseClient,
  feedId: string,
  fence: string,
  documents: ImportedSourceDocument[],
): Promise<Archived> {
  const { data, error } = await supabase.rpc(ARCHIVE_SYNC_FUNCTION, { p_feed_id: feedId, p_fence: fence, p_documents: documents });
  if (error) {
    if (!isMissingNamedFunction(error, ARCHIVE_SYNC_FUNCTION)) return { failed: 'Could not archive the complete calendar source' };
    // Source archiving has no pre-0490 equivalent to fall back to; it stays
    // refused. The migration is named to the operator, never to the family.
    if (!warnedMissingArchive) {
      warnedMissingArchive = true;
      console.warn(`Calendar source archiving needs ${ARCHIVE_SYNC_FUNCTION} from migration ${APPLY_SYNC_MIGRATION}, which this database has not applied`);
    }
    return { failed: 'Calendar source sync is not available yet' };
  }
  const invalid = { failed: 'Calendar source archive returned an incomplete or invalid receipt' };
  if (!data || typeof data !== 'object' || Array.isArray(data)) return invalid;
  if (Object.keys(data).sort().join(',') !== 'groups,outcome' || !Array.isArray(data.groups)) return invalid;
  if (data.outcome === 'lost') return data.groups.length === 0 ? 'lost' : invalid;
  if (data.outcome !== 'applied' && data.outcome !== 'needs_revision_review') return invalid;
  const expected = new Set(documents.map(document => document.uid));
  if (data.groups.length !== expected.size) return invalid;
  for (const group of data.groups) {
    if (!group || typeof group !== 'object' || Array.isArray(group)
      || Object.keys(group).sort().join(',') !== 'reused,revision_id,state,uid'
      || typeof group.uid !== 'string' || !expected.delete(group.uid)
      || typeof group.revision_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(group.revision_id)
      || typeof group.reused !== 'boolean'
      || !['ready', 'needs_revision_review'].includes(group.state)
      || (data.outcome === 'applied' && group.state !== 'ready')) return invalid;
  }
  return data.outcome;
}

/** Whether the feed admits `event` as written (`assertFeedRecurrenceAdmission`). */
function admitted(event: IcsEvent): boolean {
  try { assertFeedRecurrenceAdmission(event); return true; } catch { return false; }
}

/**
 * Writes under the database's locked feed claim. Where 0490's function is
 * missing — that exact answer, naming it, and nothing else — falls back for
 * the rest of this sync to the pre-0490 writes (`legacyApplyChunk`).
 */
async function applyChunk(
  supabase: SupabaseClient,
  feedId: string,
  fence: string,
  upserts: FeedEventRow[],
  removals: string[],
  mode: { legacy: boolean },
): Promise<Applied> {
  if (mode.legacy) return legacyApplyChunk(supabase, feedId, fence, upserts);
  const { data, error } = await supabase.rpc(APPLY_SYNC_FUNCTION, { p_feed_id: feedId, p_fence: fence, p_upserts: upserts, p_removals: removals });
  if (!error) {
    if (data === 'applied' || data === 'lost') return data;
    return { failed: `${APPLY_SYNC_FUNCTION} answered ${JSON.stringify(data)}` };
  }
  if (!isMissingNamedFunction(error, APPLY_SYNC_FUNCTION)) return { failed: error.message };

  if (!warnedMissingApply) {
    warnedMissingApply = true;
    console.warn(`Calendar feed sync is writing events without ${APPLY_SYNC_FUNCTION} until migration ${APPLY_SYNC_MIGRATION} is applied: chunks are fenced by a read, not atomically, and cancelled events are not removed but written as before it`);
  }
  mode.legacy = true;
  return legacyApplyChunk(supabase, feedId, fence, upserts);
}

/**
 * The writes production made before 0490: upsert on (feed_id, external_uid),
 * the conflict target 0285 makes inferable, and no removals — a cancelled
 * event is upserted like any other (runSync). The claim is checked by reading
 * the feed row before each chunk, so a sync that has visibly lost its claim
 * stops writing; the read and the write are not one transaction, and only
 * 0490 closes that.
 */
async function legacyApplyChunk(
  supabase: SupabaseClient,
  feedId: string,
  fence: string,
  upserts: FeedEventRow[],
): Promise<Applied> {
  if (!upserts.length) return 'applied';
  const { data: held, error: readError } = await supabase.from('calendar_feeds').select('last_status, updated_at').eq('id', feedId).maybeSingle();
  if (readError || !held) return { failed: readError?.message ?? 'Calendar feed claim could not be read' };
  if (held.last_status !== SYNCING_STATUS || held.updated_at !== fence) return 'lost';
  const { error } = await supabase.from('calendar_events').upsert(upserts, { onConflict: 'feed_id,external_uid' });
  return error ? { failed: error.message } : 'applied';
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
): Promise<{ feeds: number; imported: number; sourceGroups?: number }> {
  const feedsQuery = () => supabase.from('calendar_feeds')
    .select('id, family_id, url', { count: 'exact' }).eq('family_id', familyId).order('id');
  const { data: feeds, error } = await readCountedRows(
    () => feedsQuery().limit(1000), (from, to) => feedsQuery().range(from, to), 20_000, 'calendar feeds');
  if (error) throw new Error(`Could not read every calendar feed: ${error.message}`);

  let imported = 0;
  let sourceGroups: number | undefined;
  for (const f of feeds ?? []) {
    const r = await syncFeed(supabase, f as { id: string; family_id: string; url: string });
    if (r.sourceGroups !== undefined) sourceGroups = (sourceGroups ?? 0) + r.sourceGroups;
    if (r.ok) imported += r.imported;
  }
  return { feeds: (feeds ?? []).length, imported, ...(sourceGroups === undefined ? {} : { sourceGroups }) };
}
