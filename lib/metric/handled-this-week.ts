// Shared by browser and server surfaces. Each caller supplies its own scoped
// client; the metric never chooses a service client or reads another family.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { MetricCount } from './count';
import { loadCompletedPlans } from './completed-plans';

type DB = SupabaseClient<Database>;
export type HandledCounts = { run: MetricCount };

export type HandledThisWeek = {
  available: boolean;
  /** Only dated, fully completed plans are measured. Other sources are excluded. */
  parts: HandledCounts;
  /** The recorded completed-plan subset, not every action the family handled. */
  total: MetricCount;
  undatedCompletedRuns: MetricCount;
  sinceIso: string | null;
  untilIso: string | null;
};

/**
 * Compatibility entry point for the recorded completed-plan metric. Feed
 * entries and reminder completion do not prove separate automated work, so
 * they are absent, not represented as zero. Undated history stays explicit.
 */
export async function countHandledThisWeek(
  supabase: DB,
  familyId: string,
  now: Date = new Date(),
): Promise<HandledThisWeek> {
  const result = await loadCompletedPlans(supabase, familyId, now);
  if (!result.available) return { available: false, parts: { run: null }, total: null, undatedCompletedRuns: null, sinceIso: null, untilIso: null };
  return { available: true, parts: { run: result.completedRuns }, total: result.completedRuns,
    undatedCompletedRuns: result.undatedCompletedRuns, sinceIso: result.sinceIso, untilIso: result.untilIso };
}
