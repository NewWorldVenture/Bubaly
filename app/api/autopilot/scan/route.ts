import { NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServer } from '@/lib/supabase/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { runAutopilotScan } from '@/lib/autopilot/scan';

// POST /api/autopilot/scan — on-demand Autopilot pass for the active family.
// The actual logic is shared with the cron runner in lib/autopilot/scan.
export async function POST() {
  const t = await getTranslations();
  try {
    const ctx = await requireUserContext();
    const supabase = await createServer();
    const result = await runAutopilotScan(supabase, ctx.active.familyId, ctx.user.id);
    return NextResponse.json(result);
  } catch (err) {
    console.error('Autopilot scan error:', err);
    return NextResponse.json({ error: t('scan.autopilotScanFailed') }, { status: 500 });
  }
}
