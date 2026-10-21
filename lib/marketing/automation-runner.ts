import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { emailsSent, failedAttempt, recordedActionsJson, retryOf, stepsRecorded, runSteps, type Step } from '@/lib/marketing/automation-steps';
import { readInChunks } from '@/lib/supabase/chunked-in';
import { getMarketingCustomersWithError, type MarketingCustomer } from '@/lib/marketing/customers';
import { wroteNoRows } from '@/lib/supabase/errors';

type DB = SupabaseClient<Database>;
const DAY = 86_400_000;

// Triggers we can evaluate from the customer snapshot on a schedule (no app-event
// instrumentation needed). Other triggers (form_submitted, email_opened, …) are
// event-driven and intentionally skipped by the cron runner.
export const SCHEDULED_TRIGGERS = ['customer_created', 'customer_inactive', 'payment_failed', 'high_value_detected'] as const;
export type ScheduledTrigger = (typeof SCHEDULED_TRIGGERS)[number];

const HIGH_VALUE_CENTS = 20_000; // $200 est. LTV

/** Pure: which customers currently match a scheduled trigger. Unit tested. */
export function subjectsForTrigger(trigger: string, customers: MarketingCustomer[], now: number = Date.now()): MarketingCustomer[] {
  switch (trigger) {
    case 'customer_created':
      return customers.filter((c) => c.lifecycle === 'new');
    case 'customer_inactive':
      return customers.filter((c) => {
        const t = new Date(c.lastActivityAt).getTime();
        return !Number.isNaN(t) && now - t > 30 * DAY && c.lifecycle !== 'churned';
      });
    case 'payment_failed':
      return customers.filter((c) => c.lifecycle === 'lapsed');
    case 'high_value_detected':
      return customers.filter((c) => c.estLtvCents >= HIGH_VALUE_CENTS);
    default:
      return []; // event-driven trigger — not handled by the scheduled runner
  }
}

const DEFAULT_COPY: Record<string, { subject: string; body: string }> = {
  customer_created: { subject: 'Welcome to Bubaly 👋', body: 'Thanks for joining Bubaly! Here are three things to set up first: your family calendar, a shopping list, and an invite to your partner.' },
  customer_inactive: { subject: 'We miss your family at Bubaly', body: "It's been a little while — here's what's new, and a quick win to get back on track in 2 minutes." },
  payment_failed: { subject: 'Action needed: update your Bubaly billing', body: 'We had trouble processing your latest payment. Update your card to keep your Family plan active.' },
  high_value_detected: { subject: 'A thank-you from Bubaly', body: "You're one of our most engaged families — thank you! Reply if there's anything we can do for you." },
};

export type AutomationRunSummary = {
  workflows: number; runs: number; emails: number; failures: number;
  /** Subjects this run never started because its budget ran out: a failed run, not a quiet one. */
  unserved: number;
};

/**
 * A `running` row is a LEASE, not a verdict. The row is reserved before the
 * steps run and moved on after them; a run killed in between (the function at
 * its limit, a crash) leaves it `running` with nothing anywhere to reap it, and
 * a skip-while-running rule then freezes that family's workflow for good. A
 * `running` row older than this is such a run, and is re-claimed with a
 * compare-and-set on the metadata as read, so two passes cannot both take it.
 * Longer than any one invocation can live (maxDuration), so a run genuinely in
 * flight is never taken from under it.
 */
export const STALE_RUNNING_MS = 60 * 60_000;

/** When a `running` row was claimed: the claim stamp, else the row's creation. */
function claimedAtOf(run: { metadata: unknown; created_at: string | null }): number {
  const stamp = run.metadata && typeof run.metadata === 'object' && !Array.isArray(run.metadata)
    ? (run.metadata as { claimedAt?: unknown }).claimedAt : undefined;
  return Date.parse(typeof stamp === 'string' ? stamp : (run.created_at ?? ''));
}

/**
 * Evaluate active workflows with scheduled triggers and execute them once per
 * matching customer (deduped via marketing_automation_runs.subject_key).
 * Call from cron. Idempotent: a (workflow, family) pair only runs once.
 *
 * One subject's failure is that subject's: every write a subject needs (the
 * claim, the reservation, the record of how it went) used to `throw`, which
 * left this function and skipped every subject after it in this workflow AND
 * every later workflow for the day — one refused row write ended the platform's
 * run with a 500. Each subject now runs under its own try/catch and is counted
 * in `failures`, as checkout-abandoned and wallet-allowance isolate theirs.
 *
 * `budgetMs` stops the run STARTING subjects once spent; the rest are counted
 * `unserved`, so a tail cut off by the clock is visible rather than a 200.
 */
export async function runAutomations(supabase: DB, opts: { maxPerWorkflow?: number; budgetMs?: number } = {}): Promise<AutomationRunSummary> {
  const cap = opts.maxPerWorkflow ?? 200;
  const startedAt = Date.now();
  const outOfTime = () => opts.budgetMs !== undefined && Date.now() - startedAt >= opts.budgetMs;
  const summary: AutomationRunSummary = { workflows: 0, runs: 0, emails: 0, failures: 0, unserved: 0 };

  const { data: flows, error: flowsError } = await supabase
    .from('marketing_automation_workflows')
    .select('id, trigger, steps, run_count')
    .eq('status', 'active')
    .is('deleted_at', null);
  if (flowsError) throw new Error('Could not load active marketing automation workflows.');
  if (!flows || flows.length === 0) return summary;

  const customerResult = await getMarketingCustomersWithError(supabase);
  if (customerResult.error) throw new Error('Could not load marketing customers for automation.');
  // A family that closed its account (families.closed_at) is not emailed by a
  // scheduled automation — "we miss your family" to an account they closed.
  const customers = customerResult.customers.filter((c) => !c.closedAt);

  for (const flow of flows) {
    if (!SCHEDULED_TRIGGERS.includes(flow.trigger as ScheduledTrigger)) continue;
    summary.workflows++;

    const subjects = subjectsForTrigger(flow.trigger, customers).slice(0, cap);
    if (subjects.length === 0) continue;
    if (outOfTime()) { summary.unserved += subjects.length; continue; }

    // Skip subjects this workflow already ran for.
    //
    // Asked for the workflow's WHOLE history, this read is answered with at
    // most db-max-rows and no error, and it carries no `.order()`, so which
    // thousand come back is the server's business. One row accumulates per
    // subject, so past a thousand families the dedupe map stops containing the
    // subjects in front of it and the workflow re-runs for them — re-sending an
    // automation email the docstring above promises happens once. Nothing
    // downstream catches that: the insert's `23505` branch is waiting on a
    // unique constraint the schema does not have (0020 indexes
    // (workflow_id, created_at) and does not make it unique), so this read is
    // the only guard there is.
    //
    // Ask only about the subjects actually in play. At most `cap` of them, in
    // batches of a hundred, so the answer cannot reach the cap and the map is
    // complete for every subject it is consulted about.
    const { data: prior, error: priorError } = await readInChunks<
      { id: string; subject_key: string | null; status: string; metadata: unknown; created_at: string | null }, { message: string }
    >(
      subjects.map((c) => c.familyId),
      (chunk) => supabase.from('marketing_automation_runs')
        .select('id, subject_key, status, metadata, created_at').eq('workflow_id', flow.id).in('subject_key', chunk),
    );
    if (priorError) {
      // Without the history this workflow would re-run for everyone; without
      // isolation every workflow after it would be skipped. Count it and go on.
      console.error('[marketing automation] could not load the run history for a workflow', { workflowId: flow.id, error: priorError });
      summary.failures++;
      continue;
    }
    const priorBySubject = new Map(prior.filter((r) => r.subject_key).map((r) => [r.subject_key as string, r]));

    const workflowSteps = Array.isArray(flow.steps) ? (flow.steps as unknown as Step[]) : [];
    let ran = 0;
    const fallback = DEFAULT_COPY[flow.trigger] ?? { subject: 'A note from Bubaly', body: '' };
    type RunMetadata = Database['public']['Tables']['marketing_automation_runs']['Insert']['metadata'];

    /** One subject, start to finish. Throws only for this subject; the loop below counts it. */
    const runSubject = async (c: MarketingCustomer): Promise<void> => {
      const existing = priorBySubject.get(c.familyId);
      if (existing?.status === 'completed') return;
      const nowIso = new Date().toISOString();

      let runId: string;
      // What the failed attempt already did, so its retry does not repeat a send.
      let steps = workflowSteps;
      let previous: string[] = [];
      if (existing?.status === 'running') {
        // In flight, or dead? A claim younger than STALE_RUNNING_MS is another
        // pass at work and is left alone. Older, it is re-claimed, fenced on
        // the metadata as read: the claim stamp moves with every re-claim, so a
        // second pass holding the same stale read matches nothing.
        const heldSince = claimedAtOf(existing);
        if (Number.isFinite(heldSince) && Date.now() - heldSince < STALE_RUNNING_MS) return;
        const held = existing.metadata && typeof existing.metadata === 'object' && !Array.isArray(existing.metadata) ? existing.metadata : {};
        const { data: reclaimed, error: reclaimError } = await supabase.from('marketing_automation_runs')
          .update({ metadata: { ...held, claimedAt: nowIso } as unknown as RunMetadata })
          .eq('id', existing.id).eq('status', 'running').eq('metadata', JSON.stringify(existing.metadata ?? null))
          .select('id').maybeSingle();
        if (reclaimError) throw new Error('Could not re-claim the stale automation run.');
        if (!reclaimed) return;
        runId = reclaimed.id;
      } else if (existing?.status === 'failed') {
        // Claimed only while its receipts are the ones read above: another
        // pass may have claimed it, delivered an email and recorded that in
        // between (recordedActionsJson).
        const receipts = recordedActionsJson(existing.metadata);
        const claim = supabase.from('marketing_automation_runs').update({ status: 'running' }).eq('id', existing.id);
        const asRead = receipts === null ? claim.is('metadata->actions', null) : claim.eq('metadata->actions', receipts);
        const fenced = stepsRecorded(existing.metadata) ? asRead : asRead.is('metadata->steps', null);
        const { data: claimed, error: claimError } = await fenced.eq('status', 'failed').select('id').maybeSingle();
        if (claimError) throw new Error('Could not claim the failed automation run.');
        if (!claimed) return;
        runId = claimed.id;
        ({ steps, previous } = retryOf(existing.metadata, workflowSteps));
      } else {
        const { data: reserved, error: reserveError } = await supabase.from('marketing_automation_runs').insert({
          workflow_id: flow.id, status: 'running', subject_key: c.familyId,
          // `claimedAt` dates the lease (see STALE_RUNNING_MS).
          metadata: { trigger: flow.trigger, claimedAt: nowIso } as unknown as RunMetadata,
        }).select('id').maybeSingle();
        if (reserveError) {
          if (reserveError.code === '23505') return;
          throw new Error('Could not reserve the automation run.');
        }
        if (!reserved) throw new Error('The automation run was not returned after reservation.');
        runId = reserved.id;
      }

      let actions: string[];
      try {
        actions = await runSteps(steps, { email: c.ownerEmail, name: c.name }, fallback, supabase, undefined, previous);
      } catch (error) {
        console.error('[marketing automation] scheduled steps failed', error);
        // Keep what the earlier attempt delivered: a bare failure here would
        // erase it, and the retry would send it again.
        actions = failedAttempt(steps, previous);
      }
      summary.emails += emailsSent(actions, previous);
      const failed = actions.some((action) => action.includes(':failed') || action.includes(':skipped') || action.includes(':unsupported'));
      // The steps beside their results, so a retry matches each result to the step that produced it (retryOf).
      const outcome = { trigger: flow.trigger, actions, steps } as unknown as RunMetadata;
      // Status-guarded, so zero rows means the run was moved on (a reaper marked
      // it failed) while its steps ran. The steps DID run — the emails went — so
      // it is still counted as run; what is lost is the record of how it went,
      // and the ledger now says "failed" for sends that happened. Logged, since
      // there is no longer a row this path owns to correct. Audit C1-S9-67.
      const { data: recorded, error: runError } = await supabase.from('marketing_automation_runs')
        .update({ status: failed ? 'failed' : 'completed', metadata: outcome })
        .eq('id', runId).eq('status', 'running').select('id');
      if (runError) {
        // The row this pass reserved is still `running`, and left so it would
        // be skipped until the stale lease frees it. Move it to `failed` under
        // the same fence, receipts included, so the next pass retries only what
        // did not go out. If this write is refused too, the lease is the reaper.
        const { data: released, error: releaseError } = await supabase.from('marketing_automation_runs')
          .update({ status: 'failed', metadata: outcome })
          .eq('id', runId).eq('status', 'running').select('id');
        if (releaseError || wroteNoRows(released)) {
          console.error('[marketing automation] a run whose outcome could not be recorded was not released either', { runId, error: releaseError ?? 'no rows updated' });
        }
        throw new Error('Could not record the automation run.');
      }
      if (wroteNoRows(recorded)) {
        console.error('[marketing automation] run finished after it was moved on; its outcome was not recorded', { runId, actions });
      }
      ran++;
      summary.runs++;
      if (failed) summary.failures++;
    };

    for (let i = 0; i < subjects.length; i++) {
      if (outOfTime()) { summary.unserved += subjects.length - i; break; }
      try {
        await runSubject(subjects[i]);
      } catch (error) {
        // This subject's failure, not the run's: the next subject and the next
        // workflow still get their turn, and the response says a failure happened.
        summary.failures++;
        console.error('[marketing automation] a subject could not be run', { workflowId: flow.id, subject: subjects[i].familyId, error });
      }
    }
    if (ran > 0) {
      // Rows deliberately not checked, as in automation-events. Audit C1-S9-67.
      const { error: updateError } = await supabase.from('marketing_automation_workflows')
        .update({ run_count: (flow.run_count ?? 0) + ran }).eq('id', flow.id);
      if (updateError) {
        // The count is bookkeeping; the runs happened. Counted, not thrown.
        summary.failures++;
        console.error('[marketing automation] could not update the automation run count', { workflowId: flow.id, error: updateError });
      }
    }
  }

  return summary;
}
