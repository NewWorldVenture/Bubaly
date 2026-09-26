import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

/**
 * Append a row to the provider-sync audit trail, reporting a write that did not
 * land.
 *
 * Neither of these tables is telemetry nobody looks at, which is what makes a
 * discarded write here worth a helper:
 *
 *  - `sync_audit_logs` is what /dashboard/sync/history renders. A lost row is a
 *    gap in the account history a member is shown — and the actions recorded
 *    include `disconnect`, so the missing entry is exactly the one someone goes
 *    looking for when they want to know whether a provider's access was ever
 *    taken away.
 *  - `sync_provider_errors` is counted by the admin sync page, which reads it
 *    `.eq('is_fatal', true)` to say how badly sync is broken. A write that
 *    silently fails does not make that number wrong in a safe direction: it
 *    makes a failing integration look healthier than it is, on the one screen
 *    an operator uses to decide whether to act.
 *
 * Same reason as logAudit: a PostgREST insert RESOLVES with { data, error } and
 * rejects only under .throwOnError(), so wrapping one in try/catch and logging
 * from the catch reports nothing at all. The error has to be read.
 *
 * Deliberately never throws into the caller. By the time either of these runs
 * the work they describe has already happened — the sync ran, the account was
 * connected — and failing a completed action because its record failed would
 * turn a bookkeeping problem into a functional one. Be loud, not fatal.
 *
 * Two callers deliberately do NOT use these helpers, because they do something
 * with the failure rather than just reporting it, and routing them through here
 * would quietly drop that:
 *
 *  - app/api/cron/provider-sync/route.ts counts audit failures and returns the
 *    count in the cron response.
 *  - lib/services/onboarding-calendar/oauth.ts throws, because onboarding
 *    treats a connection it cannot produce a receipt for as a failed
 *    connection.
 *
 * tests/sync-write-failures-are-visible.test.ts holds both the rule and those
 * two exemptions.
 */
export async function logSyncAudit(
  supabase: SupabaseClient<Database>,
  row: Database['public']['Tables']['sync_audit_logs']['Insert'],
): Promise<void> {
  try {
    const { error } = await supabase.from('sync_audit_logs').insert(row);
    if (error) console.error(`[sync-audit] ${row.action} on ${row.provider} was not recorded`, error);
  } catch (e) {
    console.error(`[sync-audit] ${row.action} on ${row.provider} was not recorded`, e);
  }
}

/** Record a provider failure, and say so when the record itself could not be written. */
export async function logSyncProviderError(
  supabase: SupabaseClient<Database>,
  row: Database['public']['Tables']['sync_provider_errors']['Insert'],
): Promise<void> {
  try {
    const { error } = await supabase.from('sync_provider_errors').insert(row);
    if (error) console.error(`[sync-error] ${row.provider} ${row.code} was not recorded`, error);
  } catch (e) {
    console.error(`[sync-error] ${row.provider} ${row.code} was not recorded`, e);
  }
}

/**
 * Record that a sync failed: the run, the job, and the connection's health.
 *
 * Both engines (generic and Google) did this in their `catch` with three writes
 * whose results were discarded whole. The one that matters is the connection:
 * a health write that silently did nothing left /dashboard/sync showing a
 * failing integration as HEALTHY — the wrong answer, on the screen a member
 * checks to see whether it is working. The run left "running" is the other
 * visible symptom, in the sync history.
 *
 * Same rule as the helpers above — loud, never fatal: this runs after the sync
 * has already failed and `result.error` is already set, so there is nothing
 * left to fail. Zero rows is reported as well as an error, because a stamp that
 * matched nothing is lost as surely. Audit C1-S9-68.
 */
export async function recordSyncFailure(
  supabase: SupabaseClient<Database>,
  params: { runId: string | null; jobId: string | null; accountId: string; message: string; startedAt: number },
): Promise<void> {
  const report = (what: string, error: unknown, data: unknown) => {
    if (error || !Array.isArray(data) || data.length === 0) {
      console.error(`[sync] could not record the failure on the ${what}`, {
        accountId: params.accountId, error: error ?? 'no rows updated',
      });
    }
  };
  // try/catch as the helpers above have: a REJECTED request (the network, not
  // the database) must not escape into the engine's own catch block either.
  try {
    if (params.runId) {
      const { data, error } = await supabase.from('sync_job_runs')
        .update({ status: 'failed', sync_status: 'error', error: params.message, finished_at: new Date().toISOString(), duration_ms: Date.now() - params.startedAt })
        .eq('id', params.runId).select('id');
      report('run', error, data);
    }
    if (params.jobId) {
      const { data, error } = await supabase.from('sync_jobs')
        .update({ status: 'failed', last_error: params.message })
        .eq('id', params.jobId).select('id');
      report('job', error, data);
    }
    const { data, error } = await supabase.from('sync_connections')
      .update({ health: 'error', sync_status: 'error', last_error: params.message })
      .eq('account_id', params.accountId).select('id');
    report('connection health', error, data);
  } catch (e) {
    console.error('[sync] could not record the failure', { accountId: params.accountId, error: e });
  }
}
