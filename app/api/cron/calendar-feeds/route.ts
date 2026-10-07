import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { readCountedRows } from '@/lib/calendar/occurrences';
import { syncFeed } from '@/lib/server/calendar-feeds';
import { hasCronAuthorization } from '@/lib/server/cron-auth';

export const runtime = 'nodejs';
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
  const query = () => supabase.from('calendar_feeds').select('id, family_id, url', { count: 'exact' }).order('id');
  const { data: feeds, error } = await readCountedRows<{ id: string; family_id: string; url: string }>(
    () => query().limit(1000), (from, to) => query().range(from, to), 1_000_000, 'calendar feeds');
  if (error) {
    console.error('Calendar-feed cron read failed:', error);
    return NextResponse.json({ error: t('calendarFeeds.calendarFeedProcessingFailed') }, { status: 500 });
  }

  let synced = 0;
  let imported = 0;
  let failed = 0;
  // A feed another sync holds — a member pressed "Sync now" as the cron reached
  // it — is not a failure: that sync is applying a fresher snapshot than this
  // one would. Counted apart, so one busy feed does not turn the night red.
  let busy = 0;
  for (const feed of feeds ?? []) {
    try {
      const r = await syncFeed(supabase, feed);
      if (r.ok) { synced += 1; imported += r.imported; }
      else if (r.busy || r.takenOver) busy += 1;
      else failed += 1;
    } catch (e) {
      failed += 1;
      console.error(`Calendar feed sync failed for ${feed.id}:`, e);
    }
  }

  const ok = failed === 0;
  return NextResponse.json(
    { ok, feeds: (feeds ?? []).length, synced, imported, failed, busy },
    { status: ok ? 200 : 502 },
  );
}
