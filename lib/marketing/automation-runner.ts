import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { runSteps, type Step } from '@/lib/marketing/automation-steps';
import { getMarketingCustomers, type MarketingCustomer } from '@/lib/marketing/customers';

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

export type AutomationRunSummary = { workflows: number; runs: number; emails: number };

/**
 * Evaluate active workflows with scheduled triggers and execute them once per
 * matching customer (deduped via marketing_automation_runs.subject_key).
 * Call from cron. Idempotent: a (workflow, family) pair only runs once.
 */
export async function runAutomations(supabase: DB, opts: { maxPerWorkflow?: number } = {}): Promise<AutomationRunSummary> {
  const cap = opts.maxPerWorkflow ?? 200;
  const summary: AutomationRunSummary = { workflows: 0, runs: 0, emails: 0 };

  const { data: flows } = await supabase
    .from('marketing_automation_workflows')
    .select('id, trigger, steps, run_count')
    .eq('status', 'active')
    .is('deleted_at', null);
  if (!flows || flows.length === 0) return summary;

  const customers = await getMarketingCustomers(supabase);

  for (const flow of flows) {
    if (!SCHEDULED_TRIGGERS.includes(flow.trigger as ScheduledTrigger)) continue;
    summary.workflows++;

    const subjects = subjectsForTrigger(flow.trigger, customers).slice(0, cap);
    if (subjects.length === 0) continue;

    // Skip subjects this workflow already ran for.
    const { data: prior } = await supabase.from('marketing_automation_runs').select('subject_key').eq('workflow_id', flow.id);
    const seen = new Set((prior ?? []).map((r) => r.subject_key).filter(Boolean) as string[]);

    const steps = Array.isArray(flow.steps) ? (flow.steps as unknown as Step[]) : [];
    let ran = 0;
    const fallback = DEFAULT_COPY[flow.trigger] ?? { subject: 'A note from Bubaly', body: '' };
    for (const c of subjects) {
      if (seen.has(c.familyId)) continue;
      const actions = await runSteps(steps, { email: c.ownerEmail, name: c.name }, fallback);
      summary.emails += actions.filter((a) => a === 'send_email').length;
      await supabase.from('marketing_automation_runs').insert({
        workflow_id: flow.id, status: 'completed', subject_key: c.familyId,
        metadata: { trigger: flow.trigger, actions } as unknown as Database['public']['Tables']['marketing_automation_runs']['Insert']['metadata'],
      });
      ran++;
      summary.runs++;
    }
    if (ran > 0) await supabase.from('marketing_automation_workflows').update({ run_count: (flow.run_count ?? 0) + ran }).eq('id', flow.id);
  }

  return summary;
}
