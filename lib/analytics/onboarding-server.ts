import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { keepAttestedActivations } from '@/lib/analytics/activation-attestation';

type Cursor = { id: string; created_at: string };
type Page<T> = { data: T[] | null; error: unknown };
const PAGE_SIZE = 400;
/**
 * The earliest `created_at` any telemetry read accepts.
 *
 * `onboarding_events` and `activation_events` let the client choose
 * `created_at` (0133, 0146: no trigger pins it), and both accept an anonymous
 * row. One row dated '-infinity' sorted first, satisfied `lte(cutoff)`, came
 * back as the JSON string "-infinity", failed the cursor check below and took
 * the whole funnel — and the TTFV panel — down on every load, for good, since
 * neither table has a delete policy. A finite lower bound keeps that row (and
 * any BC or year-zero date) out of the read without loosening the check that
 * guards the cursor filter. Nothing the product recorded predates it.
 */
export const TELEMETRY_FLOOR = '2000-01-01T00:00:00.000Z';
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
  .from('onboarding_progress').select('id, user_id, created_at, completed_at, reset_at, status, value_engaged, steps_completed')
  .gte('created_at', TELEMETRY_FLOOR).lte('created_at', cutoff.toISOString()).order('created_at').order('id').limit(PAGE_SIZE), cursor));

/** Signed-in wizard runs only. The wizard renders for a signed-in account and
 * records its user (onboarding-track); a row without one is an anon-key plant. */
export const loadOnboardingEvents = (db: Db, cutoff = new Date()) => readTelemetry('onboarding_events', (cursor) => after(db
  .from('onboarding_events').select('id, user_id, session_id, step, phase, duration_ms, created_at')
  .not('user_id', 'is', null)
  .gte('created_at', TELEMETRY_FLOOR).lte('created_at', cutoff.toISOString()).order('created_at').order('id').limit(PAGE_SIZE), cursor));

/** Milestones a member recorded about their own household (keepAttestedActivations). */
export async function loadActivationEvents(db: Db, cutoff = new Date()) {
  const read = await readTelemetry('activation_events', (cursor) => after(db
    .from('activation_events').select('id, user_id, family_id, session_id, milestone, session_index, ms_since_signup, created_at')
    .not('user_id', 'is', null).not('family_id', 'is', null)
    .gte('created_at', TELEMETRY_FLOOR).lte('created_at', cutoff.toISOString()).order('created_at').order('id').limit(PAGE_SIZE), cursor));
  if (read.error || !read.data) return read;
  const attested = await keepAttestedActivations(db, read.data);
  if (attested.error) console.error('[onboarding-telemetry] activation_events membership read failed', attested.error);
  return attested;
}

/**
 * Every household created by the cutoff: the activation cohort. Cohorts used to
 * be whatever `session_id`s appeared in activation_events, and nothing records
 * a sign-up, so "New families" was only the families that had already opened
 * Briefing or Outcomes or imported a feed — the activation rate's denominator
 * selected on its own numerator.
 */
export const loadActivationCohorts = (db: Db, cutoff = new Date()) => readTelemetry('families', (cursor) => after(db
  .from('families').select('id, created_at')
  .gte('created_at', TELEMETRY_FLOOR).lte('created_at', cutoff.toISOString()).order('created_at').order('id').limit(PAGE_SIZE), cursor));

/** The TTFV panel's two reads: the milestones, and the households they are a share of. Either failing fails both. */
export async function loadActivationTelemetry(db: Db, cutoff = new Date()) {
  const [events, cohorts] = await Promise.all([loadActivationEvents(db, cutoff), loadActivationCohorts(db, cutoff)]);
  if (events.error || !events.data) return { data: null, error: events.error ?? new Error('Activation telemetry was unavailable') };
  if (cohorts.error || !cohorts.data) return { data: null, error: cohorts.error ?? new Error('Activation cohorts were unavailable') };
  return { data: { events: events.data, cohorts: cohorts.data.map((row) => row.id) }, error: null };
}
