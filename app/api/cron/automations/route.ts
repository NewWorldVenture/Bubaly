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
    return NextResponse.json({ ok: true, ...summary });
  } catch (err) {
    console.error('Automation runner error:', err);
    return NextResponse.json({ error: t('automations.automationRunFailed') }, { status: 500 });
  }
}
