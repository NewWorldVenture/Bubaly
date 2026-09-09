import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { MetricCount } from './count';
import { computeTimeSaved, type SavedKind, type TimeSavedResult } from './time-saved';
import { countHandledThisWeek } from './handled-this-week';

// Existing server callers keep this entry point; browser callers use the same
// implementation directly from handled-this-week, which has no server imports.
export { countHandledThisWeek, type HandledCounts, type HandledThisWeek } from './handled-this-week';

type DB = SupabaseClient<Database>;

/**
 * The ONE time-saved definition. Every surface that says "Bubaly saved you N"
 * reads this — Home, the Experience scorecard and the brief all quote the same
 * arithmetic over the same four sources.
 *
 * Returns `{ available: false }` when any source could not be read. The old
 * implementation returned 0 for a failed read and the banner then hid itself,
 * so an outage looked exactly like a quiet week; that mock pattern is the bug
 * this replaces.
 */
export async function loadTimeSaved(
  supabase: DB,
  familyId: string,
  now: Date = new Date(),
): Promise<TimeSavedResult> {
  const { parts } = await countHandledThisWeek(supabase, familyId, now);
  const entries = Object.entries(parts) as [SavedKind, MetricCount][];
  if (entries.some(([, count]) => count === null)) return { available: false };
  return {
    available: true,
    data: computeTimeSaved(entries.map(([kind, count]) => ({ kind, count: count as number }))),
  };
}

// TODO(S-15, needs migration): a weekly series for these numbers needs a
// `family_metric_weeks` table (family_id, week_start, metric, value) so the
// trend can be charted instead of recomputed for the last seven days on every
// page view. No migration is added here by design — the DDL is written up in
// the section's notes for the repository owner to apply.
