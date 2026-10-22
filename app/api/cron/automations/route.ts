import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { runAutomations } from '@/lib/marketing/automation-runner';
import { hasCronAuthorization } from '@/lib/server/cron-auth';
import { pruneRateLimits } from '@/lib/server/rate-limit-db';
import { pruneChildLoginThrottle } from '@/lib/auth/child-throttle-store';

export const runtime = 'nodejs';

// Lifecycle automation runner. Fires active marketing workflows whose triggers
// are evaluable from the customer snapshot (welcome, re-engagement, dunning,
// high-value), once per matching family. Scheduled via Vercel Cron.
export async function GET(req: NextRequest) {
  const t = await getTranslations();
  if (!hasCronAuthorization(req)) {
    return NextResponse.json({ error: t('automations.unauthorized') }, { status: 401 });
  }
  try {
    const supabase = createServiceClient();
    // Housekeeping on the same daily tick: the durable limiter's old windows
    // (lib/server/rate-limit-db.ts). Run first, so an automation failure cannot
    // skip it; a prune that did not land fails the run like any other failure,
    // because a silent one is how the table came to keep every bucket it was
    // ever given.
    const rateLimitsPruned = await pruneRateLimits(supabase);
    if (!rateLimitsPruned) console.error('[automations cron] rate_limit_prune did not complete');
    // The child sign-in throttle grows a row per username anyone types and had
    // no prune at all (lib/auth/child-throttle-store.ts; audit N7). Same tick,
    // same rule: a prune that did not land fails the run.
    const childLoginThrottlePruned = await pruneChildLoginThrottle(supabase);
    if (!childLoginThrottlePruned) console.error('[automations cron] child_login_throttle prune did not complete');
    const summary = await runAutomations(supabase);
  // A failed run must be visible in the status code: nothing in this directory
  // writes a durable run record, so Vercel Cron's status is the only signal, and
  // a 200 with a non-zero failure count reads as a clean run.
    const ok = summary.failures === 0 && rateLimitsPruned && childLoginThrottlePruned;
    return NextResponse.json({ ...summary, rateLimitsPruned, childLoginThrottlePruned, ok }, { status: ok ? 200 : 502 });
  } catch (err) {
    console.error('Automation runner error:', err);
    return NextResponse.json({ error: t('automations.automationRunFailed') }, { status: 500 });
  }
}
