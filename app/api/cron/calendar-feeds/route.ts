import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { readCountedRows } from '@/lib/calendar/occurrences';
import { syncFeed } from '@/lib/server/calendar-feeds';
import { hasCronAuthorization } from '@/lib/server/cron-auth';

export const runtime = 'nodejs';
// Chosen rather than inherited from the platform default. One feed's fetch is
// bounded only by 15 s per hop (lib/server/public-calendar-fetch.ts), so a few
// unresponsive hosts at the head of a stable `order('id')` ran the function
// into its limit every night, and the feeds after them — the same ones every
// night — silently never refreshed. The read is now stalest-first, the sync
// runs a few feeds at once, and the run stops STARTING feeds once the budget is
// spent and reports the rest as `unreached`: a failed run, not a quiet one.
export const maxDuration = 300;
const BUDGET_MS = 240_000;
// Against host latency, not CPU: one slow feed must not serialise the night.
const CONCURRENCY = 4;
// Public ICS calendars change over time. This nightly cron re-fetches every
// subscribed feed and upserts its events (deduped by feed_id + external_uid),
// so Bubaly mirrors the source calendar without ever duplicating events.
export async function GET(req: NextRequest) {
  const t = await getTranslations();
  if (!hasCronAuthorization(req)) {
    return NextResponse.json({ error: t('calendarFeeds.unauthorized') }, { status: 401 });
  }

  const supabase = createServiceClient();
  // Every one, not the first thousand: an unbounded select stops at PostgREST's
  // row ceiling and reports nothing, so the reminders past it would simply never
  // be sent. Every page is checked against the same exact count and identities.
  // Feeds of OPEN families only (families.closed_at): a closed account's
  // calendar is not refreshed. Filtered in the query so the exact count the
  // pages are checked against is the same filtered set.
  // Stalest first, NULLS FIRST: a feed never synced is the most urgent row,
  // and a feed that took last night's run down with it (claimed and stamped by
  // syncFeed before it fetched) has moved to the back. `id` keeps the pages
  // stable; the whole list is read before any feed is written.
  const query = () => supabase.from('calendar_feeds')
    .select('id, family_id, url, family:families!inner(closed_at)', { count: 'exact' })
    .is('family.closed_at', null).order('last_synced_at', { ascending: true, nullsFirst: true }).order('id');
  const { data: feeds, error } = await readCountedRows<{ id: string; family_id: string; url: string }>(
    () => query().limit(1000), (from, to) => query().range(from, to), 1_000_000, 'calendar feeds');
  if (error) {
    console.error('Calendar-feed cron read failed:', error);
    return NextResponse.json({ error: t('calendarFeeds.calendarFeedProcessingFailed') }, { status: 500 });
  }

  let synced = 0;
  let imported = 0;
  // Successfully archived UID groups include review-held revisions. They are
  // not materialized event/occurrence counts and do not make a failed run OK.
  let sourceGroups: number | undefined;
  let failed = 0;
  // A feed another sync holds — a member pressed "Sync now" as the cron reached
  // it — is not a failure: that sync is applying a fresher snapshot than this
  // one would. Counted apart, so one busy feed does not turn the night red.
  let busy = 0;
  // Feeds this run never STARTED, because the budget ran out first.
  const unreached: string[] = [];
  const startedAt = Date.now();
  const queue = feeds ?? [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < queue.length) {
      const feed = queue[cursor++];
      if (Date.now() - startedAt >= BUDGET_MS) { unreached.push(feed.id); continue; }
      try {
        const r = await syncFeed(supabase, feed);
        if (r.sourceGroups !== undefined) sourceGroups = (sourceGroups ?? 0) + r.sourceGroups;
        if (r.ok) { synced += 1; imported += r.imported; }
        else if (r.busy || r.takenOver) busy += 1;
        else failed += 1;
      } catch (e) {
        failed += 1;
        console.error(`Calendar feed sync failed for ${feed.id}:`, e);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));
  if (unreached.length > 0) {
    console.error(`[calendar-feeds] budget reached with ${unreached.length} feeds unreached`, unreached.slice(0, 50));
    // An unreached tail is a failed run: it must not look like a clean one.
    failed += unreached.length;
  }

  const ok = failed === 0;
  return NextResponse.json(
    { ok, feeds: queue.length, synced, imported, failed, busy, unreached: unreached.length, ...(sourceGroups === undefined ? {} : { sourceGroups }) },
    { status: ok ? 200 : 502 },
  );
}
