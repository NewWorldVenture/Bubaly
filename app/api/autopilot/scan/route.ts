import { NextResponse } from 'next/server';
import { getLocaleContext, getTranslations } from '@/lib/i18n/server';
import { createServer } from '@/lib/supabase/server';
import { isSuperAdmin, requireUserContext } from '@/lib/supabase/auth';
import { resolveFeatureEntitlement } from '@/lib/server/feature-entitlement';
import { runAutopilotScan } from '@/lib/autopilot/scan';

const AUTOPILOT_FEATURE_HREF = '/dashboard/autopilot';

// POST /api/autopilot/scan — on-demand Autopilot pass for the active family.
// The actual logic is shared with the cron runner in lib/autopilot/scan.
//
// Autopilot is a Plus feature. This route used to require only a session, so
// any signed-in member of any family could run the whole pass — the same work
// the page and the resolve action refuse them. It is gated by the same resolver
// those two use.
export async function POST() {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const supabase = await createServer();

  // Outside the catch below: a plan that cannot be read is not an unentitled
  // family, and must not be reported as either a refusal or a completed scan.
  let entitlement;
  try {
    entitlement = await resolveFeatureEntitlement(supabase, ctx.active.familyId, AUTOPILOT_FEATURE_HREF);
  } catch (err) {
    console.error('[autopilot] plan read failed', err);
    return NextResponse.json({ error: t('scan.autopilotScanFailed') }, { status: 503 });
  }
  // A super administrator previews the page past its plan (requireFeature),
  // so the scan behind it lets them through too — the route gate does the same
  // (lib/server/route-feature-gate.ts). The nightly cron does not: it runs each
  // family on its real plan. Audit C1-S9-98.
  let previewing = false;
  if (!entitlement.allowed) {
    try {
      previewing = await isSuperAdmin();
    } catch (err) {
      console.error('[autopilot] account read failed', err);
      return NextResponse.json({ error: t('scan.autopilotScanFailed') }, { status: 503 });
    }
  }
  if (!entitlement.allowed && !previewing) {
    // 'off' is not a plan problem and must not read as one: the feature does
    // not exist for anybody, so it is a 404 exactly as the page's notFound().
    if (entitlement.reason === 'off') return NextResponse.json({ error: t('scan.autopilotScanFailed') }, { status: 404 });
    return NextResponse.json({ error: t('scan.autopilotScanFailed'), needLevel: entitlement.needLevel }, { status: 403 });
  }

  try {
    // The family's zone comes off the context that is already loaded — no
    // second read, and never the server's zone. `ctx.active.family` is the
    // `families` row, so `timezone` is the column 0002 defaults to 'UTC'.
    // And the words are the READER's: the member who pressed Rescan. The scan
    // stores the suggestions it creates, and sends the urgent ones as a
    // notification, in the format of the person who asked for them. The screens
    // do not rely on that: each words a subscription title again for its own
    // reader from the facts in its payload (autopilotTitleFor).
    const { locale } = await getLocaleContext();
    const result = await runAutopilotScan(
      supabase, ctx.active.familyId, ctx.user.id, ctx.active.family.timezone || 'UTC', locale.code, t,
    );
    return NextResponse.json(result);
  } catch (err) {
    console.error('Autopilot scan error:', err);
    return NextResponse.json({ error: t('scan.autopilotScanFailed') }, { status: 500 });
  }
}
