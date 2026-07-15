import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { withGuardianTables } from '@/lib/supabase/guardian-tables';
import { runLearningForFamily } from '@/lib/guardian/learning-run';
import { hasCronAuthorization } from '@/lib/server/cron-auth';

export const runtime = 'nodejs';
export const maxDuration = 60;

// Adaptive AI Learning — nightly pass over every family that has Guardian
// activity. Generates parent-approvable suggestions (trust upgrades, blocks,
// quiet-hours rules) from recent communication patterns. Also auto-dismisses
// suggestions past their expiry. The AI only proposes — parents approve.
// Scheduled via Vercel Cron.
export async function GET(req: NextRequest) {
  if (!hasCronAuthorization(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const supabase = createServiceClient();
    const db = withGuardianTables(supabase);
    const gFrom = (t: Parameters<typeof db.from>[0]) => (db.from(t) as ReturnType<typeof supabase.from>);

    // Auto-dismiss expired pending suggestions first (housekeeping).
    const { error: dismissError } = await gFrom('guardian_suggestions')
      .update({ status: 'auto_dismissed' })
      .eq('status', 'pending')
      .lt('expires_at', new Date().toISOString());
    if (dismissError) throw new Error('Guardian suggestion cleanup failed');

    // Find families with recent Guardian activity (last 60 days).
    const since = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    const { data: recent, error: recentError } = await gFrom('guardian_communications')
      .select('family_id')
      .gte('started_at', since)
      .limit(5000);
    if (recentError) throw new Error('Guardian activity lookup failed');

    const rows = (recent ?? []) as Array<{ family_id: string }>;
    const families = Array.from(new Set(rows.map((r) => r.family_id)));

    let totalCreated = 0;
    let failed = 0;
    for (const familyId of families) {
      try {
        const res = await runLearningForFamily(supabase, familyId);
        totalCreated += res.created;
      } catch (err) {
        failed++;
        console.error('Guardian learning failed for family', familyId, err);
      }
    }

    const ok = failed === 0;
    return NextResponse.json(
      { ok, families: families.length, suggestionsCreated: totalCreated, failed },
      { status: ok ? 200 : 502 },
    );
  } catch (err) {
    console.error('Guardian learning cron error:', err);
    return NextResponse.json({ error: 'Learning run failed' }, { status: 500 });
  }
}
