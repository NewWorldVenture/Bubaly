import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { runAutomations } from '@/lib/marketing/automation-runner';
import { hasCronAuthorization } from '@/lib/server/cron-auth';
import { pruneRateLimits } from '@/lib/server/rate-limit-db';

export const runtime = 'nodejs';
// Chosen rather than inherited from the platform default: the runner sends up
// to 200 emails per workflow, serially, and a run killed mid-loop left its
// subject's row `running` for good (lib/marketing/automation-runner.ts).
export const maxDuration = 300;
// The runner stops STARTING subjects once this much is spent and reports the
// rest as `unserved`, so the function ends on its own and the tail is visible.
const RUN_BUDGET_MS = 240_000;

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
    const summary = await runAutomations(supabase, { budgetMs: RUN_BUDGET_MS });
  // A failed run must be visible in the status code: nothing in this directory
  // writes a durable run record, so Vercel Cron's status is the only signal, and
  // a 200 with a non-zero failure count reads as a clean run. A subject the
  // budget cut off (`unserved`) is a failed run for the same reason.
    const ok = summary.failures === 0 && summary.unserved === 0 && rateLimitsPruned;
    return NextResponse.json({ ...summary, rateLimitsPruned, ok }, { status: ok ? 200 : 502 });
  } catch (err) {
    console.error('Automation runner error:', err);
    return NextResponse.json({ error: t('automations.automationRunFailed') }, { status: 500 });
  }
}
