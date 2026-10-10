import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { hasCronAuthorization } from '@/lib/server/cron-auth';
import { enforceLocationRetention } from '@/lib/location/retention';

export const runtime = 'nodejs';
export const maxDuration = 60;

// Location history retention — daily. location_events kept every member's
// exact coordinates forever: "Stop Sharing" did not touch them and 0335 makes
// the table append-only for clients, so no member could remove them either.
// Events older than the window are deleted, and coordinates nothing reads are
// cleared. Idempotent: a second run the same day finds nothing to do.
export async function GET(req: NextRequest) {
  const tr = await getTranslations();
  if (!hasCronAuthorization(req)) {
    return NextResponse.json({ error: tr('locationRetention.unauthorized') }, { status: 401 });
  }
  try {
    const result = await enforceLocationRetention(createServiceClient());
    if (!result.ok) console.error('[location-retention] sweep incomplete', result.failures);
    const { ok, purgedEvents, clearedEvents, clearedCheckIns } = result;
    return NextResponse.json(
      { ok, purgedEvents, clearedEvents, clearedCheckIns, failed: result.failures.length },
      { status: ok ? 200 : 502 },
    );
  } catch (err) {
    console.error('[location-retention] cron error:', err);
    return NextResponse.json({ error: tr('locationRetention.retentionFailed') }, { status: 500 });
  }
}
