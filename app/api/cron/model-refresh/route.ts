import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import type { LocaleCode } from '@/lib/i18n/locales';
import { getMessages, translate } from '@/lib/i18n/messages';
import { createServiceClient } from '@/lib/supabase/server';
import { runTwinProjection } from '@/lib/twin/project-server';
import { runPrepGeneration } from '@/lib/planning/prep-server';
import { runSignalDetection } from '@/lib/intelligence/hard-signals-server';
import { needsRefresh, summarizeSweep, type RefreshOutcome } from '@/lib/planning/refresh';
import { hasCronAuthorization } from '@/lib/server/cron-auth';
import { sweepFamilies } from '@/lib/server/cron-family-sweep';
import { lastDailySlot, MODEL_REFRESH_SLOTS } from '@/lib/server/cron-slot';
import { readAll } from '@/lib/supabase/read-all';

export const runtime = 'nodejs';
export const maxDuration = 60;
// Each family's refresh is three serial multi-query passes (twin, prep,
// signals), and with a six-hour TTL against two runs a day nearly every family
// is stale on every run. The serial loop had no clock and no per-family bound:
// a hung read (the service client's fetch has no timeout) held it until the
// platform killed the function, which lost the response and left every family
// after it, in id order, unrefreshed every run. The pass now stops STARTING
// families once this much of maxDuration is spent and reports the rest as
// failures, gives each family a timeout, and rotates where it starts
// (lib/server/cron-family-sweep.ts), as guardian-learning and autopilot-scan do.
const BUDGET_MS = 40_000;
const FAMILY_TIMEOUT_MS = 12_000;
const FAMILY_CONCURRENCY = 4;

// Signal detection STORES a sentence with money in it (budget drift), and this
// cron has no reader to word it for: a family's language lives only in the
// browsing member's cookie, with no column on any family, member or profile row
// to read here (I18N-001). So it is en-US, said out loud rather than inherited
// from a request that does not exist. No screen shows these stored words as
// written: the family-signals page and the reasoning report
// (lib/reasoning/engine-server.ts) both word budget drift again from its
// `evidence` for their reader, and the proactive AI context words it in en-US
// (signalWordsFor in lib/intelligence/hard-signals.ts).
const SIGNAL_LOCALE: LocaleCode = 'en-US';
const signalText = (key: string, params?: Record<string, string | number>) => translate(getMessages(SIGNAL_LOCALE), key, params);

// Model-refresh cron — keeps the Household Twin graph + Prep Plans continuously
// updated for every family WITHOUT anyone opening the app. Reuses the exact same
// service-callable cores the on-demand buttons call. Scheduled via Vercel Cron.
export async function GET(req: NextRequest) {
  const t = await getTranslations();
  if (!hasCronAuthorization(req)) {
    return NextResponse.json({ error: t('modelRefresh.unauthorized') }, { status: 401 });
  }
  try {
    const supabase = createServiceClient();
    const now = new Date();
    // `.limit(N)` is not a bound — PostgREST caps a response at db-max-rows
    // whatever the client asked for, so this quietly read 1,000. `max` is the
    // same ceiling, honoured by paging to it. See lib/supabase/read-all.ts.
    // `timezone` is selected alongside `id` because prep generation needs each
    // family's OWN day, and this loop is already holding that family's row. A
    // cron over every family is not a reason to fall back to Greenwich: the
    // whole point of prep plans is "a trip departing today", and read against
    // Greenwich's today that trip is filtered out as already gone for every
    // family west of UTC during their own evening.
    // OPEN families only: a closed account (families.closed_at) is not modelled.
    const { rows: families, error } = await readAll((from, to) => supabase
      .from('families').select('id, timezone').is('closed_at', null).order('id').range(from, to), { max: 5000 });
    if (error) throw error;

    // Batch the skip-decision reads into ONE query instead of 2-per-family, so the
    // cron scales to thousands of families without blowing maxDuration. The dirty
    // table's own `refreshed_at` (written below on success) is the authoritative
    // last-refresh time. Best-effort: if the table isn't migrated yet, the map is
    // empty and every family falls through to a refresh.
    const dirtyByFamily = new Map<string, { dirty: boolean; refreshedAt: string | null }>();
    // `.limit(N)` is not a bound — PostgREST caps a response at db-max-rows
    // whatever the client asked for, so this quietly read 1,000. `max` is the
    // same ceiling, honoured by paging to it. See lib/supabase/read-all.ts.
    const { rows: dirtyRows, error: dirtyRowsError } = await readAll((from, to) => supabase
      .from('family_model_dirty')
      .select('family_id, dirty, refreshed_at').order('family_id').range(from, to), { max: 10000 });
    if (dirtyRowsError) throw dirtyRowsError;
    for (const r of dirtyRows ?? []) {
      dirtyByFamily.set(r.family_id, { dirty: r.dirty ?? false, refreshedAt: r.refreshed_at ?? null });
    }

    const outcomes: RefreshOutcome[] = [];
    // `counted.current` is false once the pass stopped waiting for a family: its
    // late outcome is not recorded on top of its timeout. The run is named by its
    // slot (04:00 or 16:00), so the 16:00 run starts half the ring past the
    // 04:00 one rather than at the same family.
    // Counted from the start of the request, so the family reads above are
    // inside the budget too.
    const startedAt = now.getTime();
    const run = lastDailySlot(startedAt, MODEL_REFRESH_SLOTS);
    const swept = await sweepFamilies(families ?? [], {
      budgetMs: BUDGET_MS, itemTimeoutMs: FAMILY_TIMEOUT_MS, concurrency: FAMILY_CONCURRENCY, startedAt,
      runIndex: run.day, slot: { index: run.slot, of: MODEL_REFRESH_SLOTS.length },
    }, async (fam, counted) => {
      try {
        // Event-driven: refresh if a source change marked the family dirty, or if
        // the last completed refresh is stale past the TTL. Otherwise skip.
        const state = dirtyByFamily.get(fam.id);
        if (!needsRefresh({ dirty: state?.dirty ?? false, lastRefreshedAt: state?.refreshedAt ?? null, now })) {
          if (counted.current) outcomes.push({ familyId: fam.id, ok: true, skipped: true });
          return;
        }
        const twin = await runTwinProjection(supabase, fam.id, null);
        const prep = await runPrepGeneration(supabase, fam.id, null, fam.timezone || 'UTC', now);
        // R10: keep the hard-signal family intelligence current too. Non-fatal —
        // a signal-detection hiccup must not fail the twin/prep refresh.
        // The service client reads the whole household, so this scan retires
        // what has stopped (SignalReach).
        try { await runSignalDetection(supabase, fam.id, SIGNAL_LOCALE, signalText, now, fam.timezone || 'UTC', 'household'); } catch (e) { console.error(`Signal detection failed for ${fam.id}:`, e); }
        let ok = twin.ok && prep.ok;
        let dirtyWriteFailed = false;
        // Clear the dirty flag once a refresh succeeds.
        if (ok) {
          const { error: dirtyWriteError } = await supabase.from('family_model_dirty')
            .upsert({ family_id: fam.id, dirty: false, refreshed_at: now.toISOString() }, { onConflict: 'family_id' });
          if (dirtyWriteError) {
            console.error(`Model-refresh dirty-state write failed for ${fam.id}:`, dirtyWriteError);
            ok = false;
            dirtyWriteFailed = true;
          }
        }
        if (!counted.current) return;
        outcomes.push({
          familyId: fam.id, ok,
          entities: twin.entities, edges: twin.edges, plans: prep.plans,
          ...(twin.error || prep.error || dirtyWriteFailed ? { error: t('modelRefresh.modelRefreshFailed') } : {}),
        });
      } catch (err) {
        console.error(`Model-refresh cron failed for family ${fam.id}:`, err);
        if (counted.current) outcomes.push({ familyId: fam.id, ok: false, error: t('modelRefresh.modelRefreshFailed') });
      }
    });
    // A family the pass gave up waiting for, or never reached, is a family it
    // failed, not a success: either one answers 502.
    for (const fam of swept.timedOut) {
      console.error(`Model-refresh gave up waiting for family ${fam.id} after ${FAMILY_TIMEOUT_MS} ms`);
      outcomes.push({ familyId: fam.id, ok: false, error: t('modelRefresh.modelRefreshFailed') });
    }
    if (swept.unreached.length > 0) {
      console.error(`Model-refresh ran out of time: ${swept.unreached.length} families not reached`, swept.unreached.slice(0, 50).map((fam) => fam.id));
      for (const fam of swept.unreached) outcomes.push({ familyId: fam.id, ok: false, error: t('modelRefresh.modelRefreshFailed') });
    }

    const summary = summarizeSweep(outcomes);
    const ok = summary.failures === 0;
    return NextResponse.json(
      { ok, ...summary, timedOut: swept.timedOut.length, unreached: swept.unreached.length },
      { status: ok ? 200 : 502 },
    );
  } catch (err) {
    console.error('Model-refresh cron error:', err);
    return NextResponse.json({ error: t('modelRefresh.modelRefreshCronFailed') }, { status: 500 });
  }
}
