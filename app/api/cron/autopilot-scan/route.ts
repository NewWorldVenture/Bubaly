import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { runAutopilotScan } from '@/lib/autopilot/scan';
import { hasCronAuthorization } from '@/lib/server/cron-auth';
import { getFeatureTiersByHref, resolveFeatureEntitlement } from '@/lib/server/feature-entitlement';

const AUTOPILOT_FEATURE_HREF = '/dashboard/autopilot';

export const runtime = 'nodejs';
export const maxDuration = 60;

// Family Autopilot cron — the "invisible product". Runs the prediction engine
// on a schedule so predictions and reversible auto-actions happen WITHOUT
// anyone opening the app. Scheduled via Vercel Cron.
//
// For ENTITLED families only. It used to run for every family on the platform,
// which made a Plus feature do its full work for families that do not have it:
// the scan writes behavioural traits to `family_digital_twin_profiles`,
// auto-creates `reminders` and `grocery_items`, and pushes notifications. The
// page and the resolve action are both gated, so those families could not open
// Autopilot to see where any of it came from, or dismiss it.
export async function GET(req: NextRequest) {
  const t = await getTranslations();
  if (!hasCronAuthorization(req)) {
    return NextResponse.json({ error: t('autopilotScan.unauthorized') }, { status: 401 });
  }
  try {
    const supabase = createServiceClient();
    const { data: families, error } = await supabase.from('families').select('id').limit(5000);
    if (error) throw error;

    // Read once for the whole pass rather than per family.
    const tiers = await getFeatureTiersByHref(supabase);

    let scanned = 0;
    let autoExecuted = 0;
    let notified = 0;
    let policyCandidates = 0;
    let skipped = 0;
    let failures = 0;
    for (const fam of families ?? []) {
      try {
        // Inside the per-family try on purpose. `resolveFeatureEntitlement`
        // throws when the plan cannot be read, and an unreadable plan is not an
        // unentitled family — that counts as a failure for this family, never
        // as a silent skip.
        const entitlement = await resolveFeatureEntitlement(supabase, fam.id, AUTOPILOT_FEATURE_HREF, tiers);
        if (!entitlement.allowed) { skipped++; continue; }

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
      { ok, families: (families ?? []).length, entitled: (families ?? []).length - skipped - failures, skipped, scanned, autoExecuted, notified, policyCandidates, failures },
      { status: ok ? 200 : 502 },
    );
  } catch (err) {
    console.error('Autopilot cron error:', err);
    return NextResponse.json({ error: t('autopilotScan.autopilotCronFailed') }, { status: 500 });
  }
}
