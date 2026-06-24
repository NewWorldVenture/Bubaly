import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { runSteps, type Step } from '@/lib/marketing/automation-steps';
import { EVENT_DEFAULT_COPY, type EventTrigger } from '@/lib/marketing/automation-triggers';

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
};

export type FireEventResult = { workflows: number; emails: number };

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
  const result: FireEventResult = { workflows: 0, emails: 0 };

  const { data: flows } = await supabase
    .from('marketing_automation_workflows')
    .select('id, trigger, steps, run_count')
    .eq('status', 'active')
    .eq('trigger', params.trigger)
    .is('deleted_at', null);
  if (!flows || flows.length === 0) return result;

  const fallback = EVENT_DEFAULT_COPY[params.trigger];

  for (const flow of flows) {
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
    if (reserveErr || !reserved || reserved.length === 0) continue; // duplicate or error → skip

    const runId = reserved[0].id;
    const steps = Array.isArray(flow.steps) ? (flow.steps as unknown as Step[]) : [];
    const actions = await runSteps(steps, { email: params.email ?? null, name: params.name ?? null }, fallback);

    await supabase
      .from('marketing_automation_runs')
      .update({
        status: 'completed',
        metadata: { trigger: params.trigger, actions, ...(params.context ?? {}) } as unknown as Database['public']['Tables']['marketing_automation_runs']['Update']['metadata'],
      })
      .eq('id', runId);
    await supabase
      .from('marketing_automation_workflows')
      .update({ run_count: (flow.run_count ?? 0) + 1 })
      .eq('id', flow.id);

    result.workflows++;
    result.emails += actions.filter((a) => a === 'send_email').length;
  }

  return result;
}
