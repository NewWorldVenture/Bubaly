import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { runAutopilotScan } from '@/lib/autopilot/scan';
import { hasCronAuthorization } from '@/lib/server/cron-auth';

export const runtime = 'nodejs';
export const maxDuration = 60;

// Family Autopilot cron — the "invisible product". Runs the prediction engine
// for every family on a schedule so predictions and reversible auto-actions
// happen WITHOUT anyone opening the app. Scheduled via Vercel Cron.
export async function GET(req: NextRequest) {
  const t = await getTranslations();
  if (!hasCronAuthorization(req)) {
    return NextResponse.json({ error: t('autopilotScan.unauthorized') }, { status: 401 });
  }
  try {
    const supabase = createServiceClient();
    const { data: families, error } = await supabase.from('families').select('id').limit(5000);
    if (error) throw error;

    let scanned = 0;
    let autoExecuted = 0;
    let notified = 0;
    let policyCandidates = 0;
    let failures = 0;
    for (const fam of families ?? []) {
      try {
        const r = await runAutopilotScan(supabase, fam.id, null);
        scanned += r.scanned;
        autoExecuted += r.autoExecuted;
        notified += r.notified;
        policyCandidates += r.policyCandidates;
      } catch (err) {
        failures++;
        console.error(`Autopilot cron failed for family ${fam.id}:`, err);
      }
    }

    const ok = failures === 0;
    return NextResponse.json(
      { ok, families: (families ?? []).length, scanned, autoExecuted, notified, policyCandidates, failures },
      { status: ok ? 200 : 502 },
    );
  } catch (err) {
    console.error('Autopilot cron error:', err);
    return NextResponse.json({ error: t('autopilotScan.autopilotCronFailed') }, { status: 500 });
  }
}
