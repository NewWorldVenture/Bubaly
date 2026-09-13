import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { hasCronAuthorization } from '@/lib/server/cron-auth';
import { FEED_UNREADABLE, ingestFeed, recordFeedError } from '@/lib/library/ingest';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * Subscribed podcasts gain their new episodes.
 *
 * Until this route existed a subscription only ever changed when somebody
 * opened the Library page and pressed Refresh — so "subscribe and it keeps up",
 * which is most of what subscribing means, was the one thing the feature could
 * not do. A family who subscribed in March and came back in June found March's
 * episodes.
 *
 * Ordered by how long each feed has gone unread, and BOXED rather than looping
 * over every feed in the deployment: publishers are slow, a serverless request
 * has a deadline, and a run that dies two thirds of the way through refreshes
 * the same two thirds every time. Taking the stalest N and stopping means the
 * queue drains evenly across runs.
 */
const BATCH = 40;
/** Leave room inside maxDuration to answer, rather than being killed mid-write. */
const BUDGET_MS = 240_000;

export async function GET(req: NextRequest) {
  if (!hasCronAuthorization(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createServiceClient();
  const { data: feeds, error } = await supabase
    .from('library_feeds')
    .select('id, family_id, feed_url, created_by, last_fetched_at')
    // NULLS FIRST: a subscription that has never been fetched is the most
    // urgent row in the table, not the least.
    .order('last_fetched_at', { ascending: true, nullsFirst: true })
    .limit(BATCH);
  if (error) {
    console.error('[cron:library-feeds] read failed', error);
    return NextResponse.json({ error: 'Library feed refresh failed' }, { status: 500 });
  }

  const started = Date.now();
  let refreshed = 0;
  let added = 0;
  let failed = 0;
  let skipped = 0;

  for (const feed of feeds ?? []) {
    if (Date.now() - started > BUDGET_MS) { skipped += 1; continue; }
    try {
      // `created_by` is whoever subscribed, carried onto new rows so an episode
      // has an author in the audit sense. The cron is not a person and must not
      // invent one.
      const result = await ingestFeed(supabase, feed.family_id, feed.created_by ?? '', feed.id, feed.feed_url);
      if ('error' in result) {
        failed += 1;
        await recordFeedError(supabase, feed.id, result.error);
      } else {
        refreshed += 1;
        added += result.added;
      }
    } catch (err) {
      failed += 1;
      console.error(`[cron:library-feeds] ${feed.id} failed`, err);
      await recordFeedError(supabase, feed.id, FEED_UNREADABLE);
    }
  }

  // 200 even with failures: one unreachable publisher is a normal day, and a
  // 502 here would make the dispatcher log every run as broken. The counts are
  // the signal.
  return NextResponse.json({ ok: true, feeds: (feeds ?? []).length, refreshed, added, failed, skipped });
}
