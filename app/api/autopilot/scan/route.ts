import { NextResponse } from 'next/server';
import { createServer } from '@/lib/supabase/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { runAutopilotScan } from '@/lib/autopilot/scan';

// POST /api/autopilot/scan — on-demand Autopilot pass for the active family.
// The actual logic is shared with the cron runner in lib/autopilot/scan.
export async function POST() {
  try {
    const ctx = await requireUserContext();
    const supabase = await createServer();
    const result = await runAutopilotScan(supabase, ctx.active.familyId, ctx.user.id);
    return NextResponse.json(result);
  } catch (err) {
    console.error('Autopilot scan error:', err);
    return NextResponse.json({ error: 'Autopilot scan failed' }, { status: 500 });
  }
}
