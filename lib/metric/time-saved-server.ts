import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { computeTimeSaved, type TimeSaved } from './time-saved';

type DB = SupabaseClient<Database>;

async function safeCount(p: PromiseLike<{ count: number | null; error: unknown }>): Promise<number> {
  const { count, error } = await Promise.resolve(p);
  return error ? 0 : (count ?? 0);
}

/**
 * R11 — load this week's "time saved" from the family's system-handled actions:
 * Autopilot auto-executions, items the assistants marked done, and reminders
 * delivered (last 7 days). Best-effort — a missing table counts as 0, so the
 * metric degrades to "getting started" rather than crashing the page.
 */
export async function loadTimeSaved(supabase: DB, familyId: string, now: Date = new Date()): Promise<TimeSaved> {
  const since = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const [autopilot, assistant, reminder] = await Promise.all([
    safeCount(supabase.from('autopilot_suggestions').select('id', { count: 'exact', head: true })
      .eq('family_id', familyId).eq('status', 'auto_executed').gte('created_at', since)),
    safeCount(supabase.from('agent_activity').select('id', { count: 'exact', head: true })
      .eq('family_id', familyId).eq('status', 'done').gte('created_at', since)),
    safeCount(supabase.from('family_reminders').select('id', { count: 'exact', head: true })
      .eq('family_id', familyId).eq('status', 'completed').gte('updated_at', since)),
  ]);
  return computeTimeSaved([
    { kind: 'autopilot', count: autopilot },
    { kind: 'assistant', count: assistant },
    { kind: 'reminder', count: reminder },
  ]);
}
