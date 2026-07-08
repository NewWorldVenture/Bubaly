import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { runTwinProjection } from '@/lib/twin/project-server';
import { runPrepGeneration } from '@/lib/planning/prep-server';
import { runSignalDetection } from '@/lib/intelligence/hard-signals-server';
import { needsRefresh, summarizeSweep, type RefreshOutcome } from '@/lib/planning/refresh';

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

    // Batch the skip-decision reads into ONE query instead of 2-per-family, so the
    // cron scales to thousands of families without blowing maxDuration. The dirty
    // table's own `refreshed_at` (written below on success) is the authoritative
    // last-refresh time. Best-effort: if the table isn't migrated yet, the map is
    // empty and every family falls through to a refresh.
    const dirtyByFamily = new Map<string, { dirty: boolean; refreshedAt: string | null }>();
    const { data: dirtyRows } = await supabase.from('family_model_dirty')
      .select('family_id, dirty, refreshed_at').limit(10000);
    for (const r of dirtyRows ?? []) {
      dirtyByFamily.set(r.family_id, { dirty: r.dirty ?? false, refreshedAt: r.refreshed_at ?? null });
    }

    const outcomes: RefreshOutcome[] = [];
    for (const fam of families ?? []) {
      try {
        // Event-driven: refresh if a source change marked the family dirty, or if
        // the last completed refresh is stale past the TTL. Otherwise skip.
        const state = dirtyByFamily.get(fam.id);
        if (!needsRefresh({ dirty: state?.dirty ?? false, lastRefreshedAt: state?.refreshedAt ?? null, now })) {
          outcomes.push({ familyId: fam.id, ok: true, skipped: true });
          continue;
        }
        const twin = await runTwinProjection(supabase, fam.id, null);
        const prep = await runPrepGeneration(supabase, fam.id, null, now);
        // R10: keep the hard-signal family intelligence current too. Non-fatal —
        // a signal-detection hiccup must not fail the twin/prep refresh.
        try { await runSignalDetection(supabase, fam.id, now); } catch (e) { console.error(`Signal detection failed for ${fam.id}:`, e); }
        const ok = twin.ok && prep.ok;
        // Clear the dirty flag once a refresh succeeds.
        if (ok) {
          await supabase.from('family_model_dirty')
            .upsert({ family_id: fam.id, dirty: false, refreshed_at: now.toISOString() }, { onConflict: 'family_id' });
        }
        outcomes.push({
          familyId: fam.id, ok,
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
