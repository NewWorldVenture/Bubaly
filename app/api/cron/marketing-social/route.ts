import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { runDueRecurringAds } from '@/lib/marketing/recurring-ads-runner';
import { hasCronAuthorization } from '@/lib/server/cron-auth';

export const runtime = 'nodejs';

// Recurring social ads. Every due campaign posts one occurrence, then schedules
// its next — the "set once, keeps going" half of Marketing · Social · Recurring.
//
// Cadence lives in scripts/cron-dispatch.mjs (every 15 minutes), not in
// vercel.json, which stays daily-safe for the Hobby plan. Both callers hitting
// the same route is harmless: the runner claims each occurrence with a
// compare-and-set before publishing, so a second caller finds nothing due.
export async function GET(req: NextRequest) {
  if (!hasCronAuthorization(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const summary = await runDueRecurringAds(createServiceClient());
    return NextResponse.json({ ok: true, ...summary });
  } catch (err) {
    console.error('[cron/marketing-social] recurring ad run failed', err);
    return NextResponse.json({ error: 'Recurring ad run failed.' }, { status: 500 });
  }
}
