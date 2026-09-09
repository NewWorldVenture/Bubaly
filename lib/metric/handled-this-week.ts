// Shared by browser and server surfaces. Each caller supplies its own scoped
// client; the metric never chooses a service client or reads another family.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { settle } from '@/lib/supabase/settle';
import { countOrNull, sumCounts, type MetricCount } from './count';
import { HANDLED_RUN_OR_FILTER, type SavedKind } from './time-saved';

type DB = SupabaseClient<Database>;
const WEEK_MS = 7 * 86_400_000;

export type HandledCounts = Record<SavedKind, MetricCount>;

export type HandledThisWeek = {
  /** Readable parts remain available even when another source failed. */
  parts: HandledCounts;
  /** Null when any source could not be counted. */
  total: MetricCount;
  sinceIso: string;
};

/**
 * One handled-this-week total: completed/partly completed runs under any
 * trigger, executed autopilot suggestions, completed specialist activity and
 * delivered reminders. The run filter honours both current and legacy states
 * without counting a row twice. Every source uses the same trailing week.
 */
export async function countHandledThisWeek(
  supabase: DB,
  familyId: string,
  now: Date = new Date(),
): Promise<HandledThisWeek> {
  const sinceIso = new Date(now.getTime() - WEEK_MS).toISOString();
  // Defer query construction too: a synchronous client failure and a rejected
  // transport both become an unavailable source, just like a database error.
  const read = (query: () => PromiseLike<{ count: number | null; error: unknown }>, label: string) =>
    countOrNull(settle(Promise.resolve().then(query)), label);
  const [run, autopilot, assistant, reminder] = await Promise.all([
    read(() => supabase.from('family_automation_runs').select('id', { count: 'exact', head: true })
      .eq('family_id', familyId).or(HANDLED_RUN_OR_FILTER).gte('created_at', sinceIso), 'handled runs'),
    read(() => supabase.from('autopilot_suggestions').select('id', { count: 'exact', head: true })
      .eq('family_id', familyId).eq('status', 'auto_executed').gte('created_at', sinceIso), 'autopilot executions'),
    read(() => supabase.from('agent_activity').select('id', { count: 'exact', head: true })
      .eq('family_id', familyId).eq('status', 'done').gte('created_at', sinceIso), 'assistant activity'),
    read(() => supabase.from('family_reminders').select('id', { count: 'exact', head: true })
      .eq('family_id', familyId).eq('status', 'completed').gte('updated_at', sinceIso), 'reminders delivered'),
  ]);

  const parts: HandledCounts = { run, autopilot, assistant, reminder };
  return { parts, total: sumCounts([run, autopilot, assistant, reminder]), sinceIso };
}
