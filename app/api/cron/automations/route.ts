import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { runAutomations } from '@/lib/marketing/automation-runner';
import { hasCronAuthorization } from '@/lib/server/cron-auth';

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
    const summary = await runAutomations(createServiceClient());
  // A failed run must be visible in the status code: nothing in this directory
  // writes a durable run record, so Vercel Cron's status is the only signal, and
  // a 200 with a non-zero failure count reads as a clean run.
    const ok = summary.failures === 0;
    return NextResponse.json({ ...summary, ok }, { status: ok ? 200 : 502 });
  } catch (err) {
    console.error('Automation runner error:', err);
    return NextResponse.json({ error: t('automations.automationRunFailed') }, { status: 500 });
  }
}
