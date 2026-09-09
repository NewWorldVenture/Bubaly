import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { computeTimeSaved, type TimeSavedResult } from './time-saved';
import { countHandledThisWeek } from './handled-this-week';

// Existing server callers keep this entry point; browser callers use the same
// implementation directly from handled-this-week, which has no server imports.
export { countHandledThisWeek, type HandledCounts, type HandledThisWeek } from './handled-this-week';

type DB = SupabaseClient<Database>;

/**
 * Modeled planning time for dated recorded completed plans. Neither work
 * outside this subset nor undated plans is treated as measured zero.
 */
export async function loadTimeSaved(
  supabase: DB,
  familyId: string,
  now: Date = new Date(),
): Promise<TimeSavedResult> {
  const { total, undatedCompletedRuns } = await countHandledThisWeek(supabase, familyId, now);
  if (total === null || undatedCompletedRuns === null) return { available: false };
  return {
    available: true,
    data: computeTimeSaved([{ kind: 'run', count: total }], undatedCompletedRuns),
  };
}

// TODO(S-15, needs migration): a weekly series for these numbers needs a
// `family_metric_weeks` table (family_id, week_start, metric, value) so the
// trend can be charted instead of recomputed for the last seven days on every
// page view. No migration is added here by design — the DDL is written up in
// the section's notes for the repository owner to apply.
