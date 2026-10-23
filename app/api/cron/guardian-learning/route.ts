import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { runLearningForFamily } from '@/lib/guardian/learning-run';
import { hasCronAuthorization } from '@/lib/server/cron-auth';
import { sweepFamilies } from '@/lib/server/cron-family-sweep';
import { readInChunks } from '@/lib/supabase/chunked-in';

export const runtime = 'nodejs';
export const maxDuration = 60;
// The pass stops STARTING families once this much of maxDuration is spent;
// the rest are reported as `unreached` and fail the run, so a tail the clock
// cut off is visible rather than a 200. The start rotates per run
// (lib/server/cron-family-sweep.ts), so the same tail is not cut off nightly.
const BUDGET_MS = 40_000;
// One family's four reads outliving this is that family's failure, not the run's.
const FAMILY_TIMEOUT_MS = 12_000;
const FAMILY_CONCURRENCY = 4;
// A stop so a skip-scan that is not climbing cannot become an infinite loop;
// far more households with Guardian activity than the product has.
const MAX_ACTIVE_FAMILIES = 100_000;
const DAY_MS = 86_400_000;

// Adaptive AI Learning — nightly pass over every family that has Guardian
// activity. Generates parent-approvable suggestions (trust upgrades, blocks,
// quiet-hours rules) from recent communication patterns. Also auto-dismisses
// suggestions past their expiry. The AI only proposes — parents approve.
// Scheduled via Vercel Cron.
export async function GET(req: NextRequest) {
  const tr = await getTranslations();
  if (!hasCronAuthorization(req)) {
    return NextResponse.json({ error: tr('guardianLearning.unauthorized') }, { status: 401 });
  }
  const startedAt = Date.now();
  try {
    const supabase = createServiceClient();

    // Auto-dismiss expired pending suggestions first (housekeeping). Rows
    // deliberately not checked: zero is the ordinary "nothing expired" tick.
    // Audit C1-S9-63.
    const { error: dismissError } = await supabase.from('guardian_suggestions')
      .update({ status: 'auto_dismissed' })
      .eq('status', 'pending')
      .lt('expires_at', new Date().toISOString());
    if (dismissError) throw new Error('Guardian suggestion cleanup failed');

    // Find families with recent Guardian activity (last 60 days).
    const since = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    // DISTINCT families, one short read per family rather than one row per
    // communication. This used to be a readAll over every communication of the
    // window capped at 5,000 rows — and readAll reports its ceiling as an error
    // (by design), which the throw below turned into a 500 every night: the
    // learning job was down for every family once the platform logged more than
    // 5,000 screened calls and texts in 60 days (about 83 a day), until rows
    // aged out. A skip-scan instead: the smallest `family_id` strictly after the
    // last one read, one row at a time, so the cost is the number of active
    // households and no count fails the run.
    const recentFamilies: string[] = [];
    for (let last: string | null = null; ;) {
      let active = supabase.from('guardian_communications').select('family_id').gte('started_at', since);
      if (last !== null) active = active.gt('family_id', last);
      const { data: next, error: recentError } = await active.order('family_id').order('id').limit(1);
      if (recentError) throw new Error('Guardian activity lookup failed');
      const familyId = next?.[0]?.family_id;
      if (!familyId) break;
      recentFamilies.push(familyId);
      last = familyId;
      if (recentFamilies.length > MAX_ACTIVE_FAMILIES) throw new Error('Guardian activity lookup did not terminate');
    }
    // OPEN families only (families.closed_at): a closed account gets no new
    // suggestions. The expiry sweep above is housekeeping and runs for all.
    // Chunked, so the id list travels inside the gateway's request-line limit.
    const { data: openRows, error: openError } = await readInChunks<{ id: string }, { message: string }>(
      recentFamilies,
      (chunk) => supabase.from('families').select('id').is('closed_at', null).in('id', chunk),
    );
    if (openError) throw new Error('Guardian activity lookup failed');
    const open = new Set(openRows.map((f) => f.id));
    const families = recentFamilies.filter((id) => open.has(id));

    let totalCreated = 0;
    let failed = 0;
    // Rotated, bounded and budgeted (lib/server/cron-family-sweep.ts): the
    // serial loop under maxDuration 60 had no time check, so a kill mid-loop
    // left the same families unlearned each night. `counted.current` is false
    // once the pass stopped waiting for a family: its late result is not counted
    // on top of its timeout.
    const swept = await sweepFamilies(families, {
      // Nightly: the day is the run's index, so consecutive nights start apart.
      budgetMs: BUDGET_MS, itemTimeoutMs: FAMILY_TIMEOUT_MS, concurrency: FAMILY_CONCURRENCY, startedAt, runIndex: Math.floor(startedAt / DAY_MS),
    }, async (familyId, counted) => {
      try {
        const res = await runLearningForFamily(supabase, familyId);
        if (counted.current) totalCreated += res.created;
      } catch (err) {
        if (counted.current) failed++;
        console.error('Guardian learning failed for family', familyId, err);
      }
    });
    for (const familyId of swept.timedOut) {
      failed++;
      console.error(`Guardian learning gave up waiting for family ${familyId} after ${FAMILY_TIMEOUT_MS} ms`);
    }
    const unreached = swept.unreached.length;
    if (unreached > 0) {
      console.error(`Guardian learning ran out of time: ${unreached} families not reached`, swept.unreached.slice(0, 50));
      // A family the pass never reached is a family it failed, not a success.
      failed += unreached;
    }

    const ok = failed === 0;
    return NextResponse.json(
      { ok, families: families.length, suggestionsCreated: totalCreated, failed, unreached, timedOut: swept.timedOut.length },
      { status: ok ? 200 : 502 },
    );
  } catch (err) {
    console.error('Guardian learning cron error:', err);
    return NextResponse.json({ error: tr('guardianLearning.learningRunFailed') }, { status: 500 });
  }
}
