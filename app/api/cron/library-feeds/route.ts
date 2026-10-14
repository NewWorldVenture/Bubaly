import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { hasCronAuthorization } from '@/lib/server/cron-auth';
import { FEED_UNREADABLE, ingestFeed, recordFeedError } from '@/lib/library/ingest';
import { addedByAnAdult, readCurators } from '@/lib/library/curator';
import { wroteNoRows } from '@/lib/supabase/errors';
import { getTranslations } from '@/lib/i18n/server';

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
    // Feeds of OPEN families only (families.closed_at). In the query, not after
    // it: stalest-first and bounded, a closed family's feeds — never fetched
    // again — would otherwise sit at the head of every batch.
    .select('id, family_id, feed_url, created_by, last_fetched_at, family:families!inner(closed_at)')
    .is('family.closed_at', null)
    // NULLS FIRST: a subscription that has never been fetched is the most
    // urgent row in the table, not the least.
    .order('last_fetched_at', { ascending: true, nullsFirst: true })
    .limit(BATCH);
  if (error) {
    console.error('[cron:library-feeds] read failed', error);
    return NextResponse.json({ error: 'Library feed refresh failed' }, { status: 500 });
  }

  // A feed is fetched for the family only when one of its adults added it
  // (lib/library/curator.ts): a row a child wrote over PostgREST is not.
  const curated = await readCurators(supabase, (feeds ?? []).map((f) => f.family_id), (feeds ?? []).map((f) => f.created_by));
  if (!curated.ok) {
    console.error('[cron:library-feeds] curator read failed', curated.error);
    return NextResponse.json({ error: 'Library feed refresh failed' }, { status: 500 });
  }
  const t = await getTranslations();

  const started = Date.now();
  let refreshed = 0;
  let added = 0;
  let failed = 0;
  let skipped = 0;

  for (const feed of feeds ?? []) {
    if (Date.now() - started > BUDGET_MS) { skipped += 1; continue; }
    // Claimed BEFORE it is fetched and parsed: stamped, it goes to the back of
    // the stalest-first queue. A feed that took a run down with it (a parse
    // that never returned, the run killed at maxDuration) otherwise stayed at
    // the head with last_fetched_at unwritten, and every later night died on
    // the same feed before reaching any other family's subscriptions.
    const { data: claimed, error: claimError } = await supabase.from('library_feeds')
      .update({ last_fetched_at: new Date().toISOString() })
      .eq('id', feed.id).eq('family_id', feed.family_id).select('id');
    if (claimError || wroteNoRows(claimed)) {
      failed += 1;
      console.error(`[cron:library-feeds] ${feed.id} could not be claimed`, claimError ?? 'no rows updated');
      continue;
    }
    if (!addedByAnAdult(curated, feed.family_id, feed.created_by)) {
      skipped += 1;
      await recordFeedError(supabase, feed.id, t('library.feedNotAddedByAnAdult'));
      continue;
    }
    try {
      // The cron is not a person and must not invent one: null, never `''`,
      // which is not a uuid and failed the whole upsert (22P02) every night for
      // a feed whose subscriber's account had been deleted (0284's ON DELETE
      // SET NULL). See ingestFeed on why the asker is not written onto episodes.
      const result = await ingestFeed(supabase, feed.family_id, null, feed.id, feed.feed_url);
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

  // A failed run must be visible in the status code: nothing in this directory
  // writes a durable run record, so Vercel Cron's status is the only signal, and
  // a 200 with a non-zero failure count reads as a clean run.
  const ok = failed === 0;
  return NextResponse.json(
    { ok, feeds: (feeds ?? []).length, refreshed, added, failed, skipped },
    { status: ok ? 200 : 502 },
  );
}
