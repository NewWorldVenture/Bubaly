import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { runTwinProjection } from '@/lib/twin/project-server';
import { runPrepGeneration } from '@/lib/planning/prep-server';
import { shouldRefresh, summarizeSweep, type RefreshOutcome } from '@/lib/planning/refresh';

export const runtime = 'nodejs';
export const maxDuration = 60;

// Model-refresh cron — keeps the Household Twin graph + Prep Plans continuously
// updated for every family WITHOUT anyone opening the app. Reuses the exact same
// service-callable cores the on-demand buttons call. Scheduled via Vercel Cron.
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const supabase = createServiceClient();
    const now = new Date();
    const { data: families, error } = await supabase.from('families').select('id').limit(5000);
    if (error) throw error;

    const outcomes: RefreshOutcome[] = [];
    for (const fam of families ?? []) {
      try {
        // Skip families refreshed within the TTL (e.g. someone just hit "Rebuild").
        const { data: latest } = await supabase.from('graph_entities')
          .select('updated_at').eq('family_id', fam.id).order('updated_at', { ascending: false }).limit(1).maybeSingle();
        if (!shouldRefresh(latest?.updated_at ?? null, now)) {
          outcomes.push({ familyId: fam.id, ok: true, skipped: true });
          continue;
        }
        const twin = await runTwinProjection(supabase, fam.id, null);
        const prep = await runPrepGeneration(supabase, fam.id, null, now);
        outcomes.push({
          familyId: fam.id,
          ok: twin.ok && prep.ok,
          entities: twin.entities, edges: twin.edges, plans: prep.plans,
          error: twin.error ?? prep.error,
        });
      } catch (err) {
        outcomes.push({ familyId: fam.id, ok: false, error: String(err) });
        console.error(`Model-refresh cron failed for family ${fam.id}:`, err);
      }
    }

    return NextResponse.json({ ok: true, ...summarizeSweep(outcomes) });
  } catch (err) {
    console.error('Model-refresh cron error:', err);
    return NextResponse.json({ error: 'Model-refresh cron failed' }, { status: 500 });
  }
}
