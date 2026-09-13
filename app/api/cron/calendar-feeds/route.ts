import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { readAll } from '@/lib/supabase/read-all';
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
  // be sent. See lib/supabase/read-all.ts.
  const { rows: feeds, error } = await readAll<{ id: string; family_id: string; url: string }>(
    (from, to) => supabase.from('calendar_feeds').select('id, family_id, url').order('id').range(from, to),
  );
  if (error) {
    console.error('Calendar-feed cron read failed:', error);
    return NextResponse.json({ error: t('calendarFeeds.calendarFeedProcessingFailed') }, { status: 500 });
  }

  let synced = 0;
  let imported = 0;
  let failed = 0;
  for (const feed of feeds ?? []) {
    try {
      const r = await syncFeed(supabase, feed);
      if (r.ok) { synced += 1; imported += r.imported; }
      else failed += 1;
    } catch (e) {
      failed += 1;
      console.error(`Calendar feed sync failed for ${feed.id}:`, e);
    }
  }

  const ok = failed === 0;
  return NextResponse.json(
    { ok, feeds: (feeds ?? []).length, synced, imported, failed },
    { status: ok ? 200 : 502 },
  );
}
