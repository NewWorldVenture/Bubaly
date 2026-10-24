import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { automationSendKey, emailsSent, failedAttempt, recordedActionsJson, retryableShortfall, retryOf, stepsRecorded, runSteps, unsupportedStep, worthRetrying, type SendAdmission, type Step } from '@/lib/marketing/automation-steps';
import { EVENT_DEFAULT_COPY, hasRunnableStep, stepsAreRunnable, type EventTrigger } from '@/lib/marketing/automation-triggers';
import { wroteNoRows } from '@/lib/supabase/errors';

type DB = SupabaseClient<Database>;

export type FireEventParams = {
  trigger: EventTrigger;
  /** Recipient of any send_email step (lead/customer email). */
  email?: string | null;
  name?: string | null;
  /** Unique dedup key for this occurrence — see eventSubjectKey(). */
  subjectKey: string;
  /** Extra context stored on the run for auditing. */
  context?: Record<string, unknown>;
  /**
   * Asked before EVERY mail this event would send, across every matching
   * workflow and every send_email step in each (runSteps). One event fans out
   * that far, so a per-recipient bound checked once, on the event, bounds
   * nothing per inbox. Omitted, every admitted step sends, as account and
   * campaign automations for verified addresses always have.
   */
  admitSend?: SendAdmission;
};

export type FireEventResult = {
  workflows: number; emails: number;
  /**
   * Workflows that ran and recorded a failed or skipped step: a nudge a retry
   * could still deliver. A step no runner executes is not one (`unrunnable`).
   */
  failures: number;
  /**
   * What could not even be attempted: the workflows read answered an error, or
   * a run could not be reserved or claimed. Each used to be swallowed (`{ data:
   * flows }` alone; `if (reserveErr) continue`), so a cron that fired an event
   * into a database that refused it counted the nudge as sent.
   */
  errors: number;
  /**
   * Matching workflows holding a step no runner executes, reported and never
   * failed: one switched on before the console refused them. One with no step
   * a runner executes is not run at all — no row, no run_count, no failure.
   * Counted a failure, its first run for every new subject made the caller's
   * cron answer 502 (checkout-abandoned also handed the session back), for a
   * step no retry can do.
   */
  unrunnable: number;
};

/**
 * Fires every active workflow whose trigger matches `params.trigger`, in real
 * time, from an app event. Idempotent: a unique (workflow_id, subject_key) index
 * means a redelivered webhook or double submit can't double-send. We reserve the
 * run row FIRST (insert-if-absent); only a freshly-reserved row runs the steps,
 * so a duplicate event never sends a second email.
 *
 * Best-effort by contract: callers wrap this in try/catch and never block the
 * user-facing response on it.
 */
export async function fireAutomationEvent(supabase: DB, params: FireEventParams): Promise<FireEventResult> {
  const result: FireEventResult = { workflows: 0, emails: 0, failures: 0, errors: 0, unrunnable: 0 };

  const { data: flows, error: flowsError } = await supabase
    .from('marketing_automation_workflows')
    .select('id, trigger, steps, run_count')
    .eq('status', 'active')
    .eq('trigger', params.trigger)
    .is('deleted_at', null);
  if (flowsError) {
    console.error('[marketing automation] could not read the workflows for an event', { trigger: params.trigger, error: flowsError });
    result.errors++;
    return result;
  }
  if (!flows || flows.length === 0) return result;

  const fallback = EVENT_DEFAULT_COPY[params.trigger];

  for (const flow of flows) {
    // Reported, not failed; and not run at all when nothing in it would run.
    if (!stepsAreRunnable(flow.steps)) {
      result.unrunnable++;
      const runnable = hasRunnableStep(flow.steps);
      console.warn('[marketing automation] an active workflow holds a step no runner executes', { trigger: params.trigger, workflowId: flow.id, skipped: !runnable });
      if (!runnable) continue;
    }
    // Reserve the run first so duplicates short-circuit before any email sends.
    const { data: reserved, error: reserveErr } = await supabase
      .from('marketing_automation_runs')
      .upsert(
        {
          workflow_id: flow.id,
          status: 'running',
          subject_key: params.subjectKey,
          metadata: { trigger: params.trigger, ...(params.context ?? {}) } as unknown as Database['public']['Tables']['marketing_automation_runs']['Insert']['metadata'],
        },
        { onConflict: 'workflow_id,subject_key', ignoreDuplicates: true },
      )
      .select('id');
    // Best-effort event path — callers must not block user requests — but
    // counted: a reservation that was refused is a nudge that did not go out.
    if (reserveErr) {
      console.error('[marketing automation] could not reserve an event-driven run', { trigger: params.trigger, workflowId: flow.id, error: reserveErr });
      result.errors++;
      continue;
    }

    let runId = reserved?.[0]?.id ?? null;
    // A run this event reserved, not a retry of an earlier one: only it counts in run_count.
    const firstRun = runId !== null;
    // What a failed attempt already did, so its retry does not repeat a send.
    let steps = Array.isArray(flow.steps) ? (flow.steps as unknown as Step[]) : [];
    let previous: string[] = [];
    if (!runId) {
      const { data: existing, error: existingError } = await supabase.from('marketing_automation_runs')
        .select('id, status, metadata').eq('workflow_id', flow.id).eq('subject_key', params.subjectKey).maybeSingle();
      if (existingError) {
        console.error('[marketing automation] could not read the existing event-driven run', { trigger: params.trigger, workflowId: flow.id, error: existingError });
        result.errors++;
        continue;
      }
      if (!existing || existing.status !== 'failed') continue;
      // A run that can only fail again (a step no runner executes) is left as it is.
      if (!worthRetrying(existing.metadata)) continue;
      // Claimed only while its receipts are the ones just read: another sweep
      // may have claimed it, delivered an email and recorded that in between
      // (recordedActionsJson).
      const receipts = recordedActionsJson(existing.metadata);
      const claim = supabase.from('marketing_automation_runs').update({ status: 'running' }).eq('id', existing.id);
      const asRead = receipts === null ? claim.is('metadata->actions', null) : claim.eq('metadata->actions', receipts);
      const fenced = stepsRecorded(existing.metadata) ? asRead : asRead.is('metadata->steps', null);
      const { data: claimed, error: claimError } = await fenced.eq('status', 'failed').select('id').maybeSingle();
      if (claimError) {
        console.error('[marketing automation] could not claim the failed event-driven run', { trigger: params.trigger, workflowId: flow.id, error: claimError });
        result.errors++;
        continue;
      }
      if (!claimed) continue;
      runId = claimed.id;
      ({ steps, previous } = retryOf(existing.metadata, steps));
    }
    let actions: string[];
    try {
      actions = await runSteps(steps, { email: params.email ?? null, name: params.name ?? null }, fallback, supabase, params.admitSend, previous, automationSendKey(runId));
    } catch (error) {
      console.error('[marketing automation] event-driven steps failed', error);
      // Keep what the earlier attempt delivered: a bare failure here would
      // erase it, and the retry would send it again.
      actions = failedAttempt(steps, previous);
    }

    // Recorded `failed` for any shortfall, an unsupported step included (and
    // worthRetrying leaves that one alone); counted a failure only for one a
    // retry could change, as the scheduled runner counts it.
    const retryable = retryableShortfall(actions);
    const failed = retryable || unsupportedStep(actions);
    // The run row was reserved or claimed by this path above, so zero rows is a
    // result that was not recorded — the same situation the error already
    // throws for, and it takes the same path. Audit C1-S9-67.
    const { data: recorded, error: runError } = await supabase
      .from('marketing_automation_runs')
      .update({
        status: failed ? 'failed' : 'completed',
        // The results and the steps that produced them come last, so no context key can stand in for them (retryOf).
        metadata: { trigger: params.trigger, ...(params.context ?? {}), actions, steps } as unknown as Database['public']['Tables']['marketing_automation_runs']['Update']['metadata'],
      })
      .eq('id', runId)
      .select('id');
    if (runError || wroteNoRows(recorded)) throw new Error('Could not record the event-driven automation result.');
    if (firstRun) {
      // Rows deliberately not checked: zero rows is a workflow deleted mid-run,
      // with no count left to keep. Audit C1-S9-67.
      const { error: workflowError } = await supabase
        .from('marketing_automation_workflows')
        .update({ run_count: (flow.run_count ?? 0) + 1 })
        .eq('id', flow.id);
      if (workflowError) throw new Error('Could not update the automation run count.');
    }

    result.workflows++;
    result.emails += emailsSent(actions, previous);
    if (retryable) result.failures++;
  }

  return result;
}
