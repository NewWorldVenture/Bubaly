import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { runAutopilotScan } from '@/lib/autopilot/scan';
import { hasCronAuthorization } from '@/lib/server/cron-auth';

export const runtime = 'nodejs';
export const maxDuration = 60;

// Family Autopilot cron — the "invisible product". Runs the prediction engine
// for every family on a schedule so predictions and reversible auto-actions
// happen WITHOUT anyone opening the app. Scheduled via Vercel Cron.
export async function GET(req: NextRequest) {
  if (!hasCronAuthorization(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const supabase = createServiceClient();
    const { data: families, error } = await supabase.from('families').select('id').limit(5000);
    if (error) throw error;

    let scanned = 0;
    let autoExecuted = 0;
    let notified = 0;
    let failures = 0;
    for (const fam of families ?? []) {
      try {
        const r = await runAutopilotScan(supabase, fam.id, null);
        scanned += r.scanned;
        autoExecuted += r.autoExecuted;
        notified += r.notified;
      } catch (err) {
        failures++;
        console.error(`Autopilot cron failed for family ${fam.id}:`, err);
      }
    }

    return NextResponse.json({ ok: true, families: (families ?? []).length, scanned, autoExecuted, notified, failures });
  } catch (err) {
    console.error('Autopilot cron error:', err);
    return NextResponse.json({ error: 'Autopilot cron failed' }, { status: 500 });
  }
}
