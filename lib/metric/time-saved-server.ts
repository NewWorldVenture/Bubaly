import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { countOrNull, sumCounts, type MetricCount } from './count';
import {
  HANDLED_RUN_STATES, computeTimeSaved, type SavedKind, type TimeSavedResult,
} from './time-saved';

type DB = SupabaseClient<Database>;

/** The window every "this week" number in this module is measured over. */
const WEEK_MS = 7 * 86_400_000;

/**
 * The four counts that make up "handled this week", each independently
 * knowable — and independently *un*knowable.
 */
export type HandledCounts = Record<SavedKind, MetricCount>;

export type HandledThisWeek = {
  /** Every part, so a surface can show the breakdown it can read. */
  parts: HandledCounts;
  /** The one number. `null` when any part failed to read. */
  total: MetricCount;
  /** ISO instant the window starts at, for callers that want to say so. */
  sinceIso: string;
};

/**
 * R11 / X-metrics — ONE "handled this week" accounting.
 *
 * Four sources, counted in PostgreSQL rather than fetched and tallied:
 *   * `family_automation_runs` that reached a handled lifecycle state, under
 *     ANY trigger. This is the half every previous definition was missing: a
 *     run kicked off by a routine, an inbound email or a Handle It request is
 *     as handled as one the family accepted a plan for, and counting only
 *     `plan_accepted` under-reported Bubaly's own work on its own dashboard.
 *   * Autopilot suggestions Bubaly executed on its own.
 *   * The specialist agents' completed activity.
 *   * Reminders that actually went out.
 *
 * A run is counted ONCE — the query filters `state`, so a run cannot be added
 * again by its trigger, its legacy `status`, or by the fact that it also
 * appears in the completed list the Command Center renders.
 *
 * Every count is error-aware: a failed read is `null`, never 0.
 */
export async function countHandledThisWeek(
  supabase: DB,
  familyId: string,
  now: Date = new Date(),
): Promise<HandledThisWeek> {
  const sinceIso = new Date(now.getTime() - WEEK_MS).toISOString();
  const [run, autopilot, assistant, reminder] = await Promise.all([
    countOrNull(
      supabase.from('family_automation_runs').select('id', { count: 'exact', head: true })
        .eq('family_id', familyId).in('state', HANDLED_RUN_STATES).gte('created_at', sinceIso),
      'handled runs',
    ),
    countOrNull(
      supabase.from('autopilot_suggestions').select('id', { count: 'exact', head: true })
        .eq('family_id', familyId).eq('status', 'auto_executed').gte('created_at', sinceIso),
      'autopilot executions',
    ),
    countOrNull(
      supabase.from('agent_activity').select('id', { count: 'exact', head: true })
        .eq('family_id', familyId).eq('status', 'done').gte('created_at', sinceIso),
      'assistant activity',
    ),
    countOrNull(
      supabase.from('family_reminders').select('id', { count: 'exact', head: true })
        .eq('family_id', familyId).eq('status', 'completed').gte('updated_at', sinceIso),
      'reminders delivered',
    ),
  ]);

  const parts: HandledCounts = { run, autopilot, assistant, reminder };
  return { parts, total: sumCounts([run, autopilot, assistant, reminder]), sinceIso };
}

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
