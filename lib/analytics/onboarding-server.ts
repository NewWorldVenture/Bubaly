import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

type Cursor = { id: string; created_at: string };
type Page<T> = { data: T[] | null; error: unknown };
const PAGE_SIZE = 400;
/** Admin callers authorize first. A fixed cutoff and created_at/id cursor keep
 * ordinary concurrent inserts from shifting offsets or duplicating cohorts. */
async function readTelemetry<T extends Cursor>(table: string, read: (cursor: Cursor | null) => PromiseLike<Page<T>>): Promise<Page<T>> {
  try {
    const rows: T[] = [];
    const seen = new Set<string>();
    let cursor: Cursor | null = null;
    for (;;) {
      const page = await read(cursor);
      if (page.error || !page.data) throw page.error ?? new Error('Telemetry page was unavailable');
      if (!page.data.length) return { data: rows, error: null };
      for (const row of page.data) {
        if (!/^[0-9a-f-]{36}$/i.test(row.id) || !/^\d{4}-\d\d-\d\dT[0-9:.+-]+Z?$/.test(row.created_at) || !Number.isFinite(Date.parse(row.created_at)) || seen.has(row.id)) {
          throw new Error('Telemetry cursor was invalid or repeated');
        }
        seen.add(row.id);
      }
      rows.push(...page.data);
      cursor = page.data[page.data.length - 1];
      // A server cap smaller than PAGE_SIZE is not proof of exhaustion.
    }
  } catch (error) {
    console.error(`[onboarding-telemetry] ${table} read failed`, error);
    return { data: null, error };
  }
}

type Db = SupabaseClient<Database>;
function after<T extends { or: (filter: string) => unknown }>(query: T, cursor: Cursor | null): T {
  return cursor ? query.or(`created_at.gt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.gt.${cursor.id})`) as T : query;
}
export const loadOnboardingProgress = (db: Db, cutoff = new Date()) => readTelemetry('onboarding_progress', (cursor) => after(db
  .from('onboarding_progress').select('id, created_at, completed_at, status, value_engaged, steps_completed')
  .lte('created_at', cutoff.toISOString()).order('created_at').order('id').limit(PAGE_SIZE), cursor));

export const loadOnboardingEvents = (db: Db, cutoff = new Date()) => readTelemetry('onboarding_events', (cursor) => after(db
  .from('onboarding_events').select('id, session_id, step, phase, duration_ms, created_at')
  .lte('created_at', cutoff.toISOString()).order('created_at').order('id').limit(PAGE_SIZE), cursor));

export const loadActivationEvents = (db: Db, cutoff = new Date()) => readTelemetry('activation_events', (cursor) => after(db
  .from('activation_events').select('id, session_id, milestone, session_index, ms_since_signup, created_at')
  .lte('created_at', cutoff.toISOString()).order('created_at').order('id').limit(PAGE_SIZE), cursor));
