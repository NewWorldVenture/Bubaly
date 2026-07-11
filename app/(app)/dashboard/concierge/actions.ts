'use server';

// Concierge deeper write-back — materialize an accepted plan into real records
// across MORE surfaces (calendar event · reminder · prep task), each logged to
// concierge_plan_actions so the flow is idempotent (a plan never double-applies
// the same kind) and auditable. Family-scoped via RLS.
import { revalidatePath } from 'next/cache';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import {
  availableWriteBackKinds, reminderLeadAt, writeBackTitle, type WriteBackKind,
} from '@/lib/concierge/apply';

type Result = { ok: true; applied: WriteBackKind[] } | { ok: false; error: string };

const VALID: WriteBackKind[] = ['calendar', 'reminder', 'task'];

/**
 * Apply the requested write-backs for a plan. Skips any already applied. Each
 * write creates the real record AND logs a concierge_plan_actions row.
 */
export async function applyConciergePlanAction(planId: string, kinds: WriteBackKind[]): Promise<Result> {
  if (!planId) return { ok: false, error: 'Invalid plan' };
  const requested = kinds.filter((k): k is WriteBackKind => VALID.includes(k));
  if (requested.length === 0) return { ok: false, error: 'Nothing to apply' };

  const ctx = await requireUserContext();
  const sb = await createServer();
  const familyId = ctx.active.familyId;
  const userId = ctx.user.id;

  const { data: plan } = await sb
    .from('concierge_plans')
    .select('id, title, description, location, planned_for, budget_cents')
    .eq('id', planId)
    .eq('family_id', familyId)
    .maybeSingle();
  if (!plan) return { ok: false, error: 'Plan not found' };

  // Only kinds that both were requested AND are actually available for this plan.
  const doable = new Set(availableWriteBackKinds(plan));
  const targets = requested.filter((k) => doable.has(k));

  // Skip kinds already materialized (idempotent).
  const { data: existing } = await sb
    .from('concierge_plan_actions')
    .select('action_kind')
    .eq('family_id', familyId)
    .eq('plan_id', planId);
  const already = new Set((existing ?? []).map((r) => r.action_kind));

  const applied: WriteBackKind[] = [];

  for (const kind of targets) {
    if (already.has(kind)) continue;
    try {
      let targetTable = '';
      let targetId: string | null = null;

      if (kind === 'calendar' && plan.planned_for) {
        const descParts = [plan.description, plan.location ? `Location: ${plan.location}` : null].filter(Boolean);
        const { data: ev } = await sb.from('calendar_events').insert({
          family_id: familyId, created_by: userId, title: plan.title,
          description: descParts.length ? descParts.join('\n') : null,
          location: plan.location, category: 'general',
          starts_at: new Date(`${plan.planned_for}T00:00:00.000Z`).toISOString(), all_day: true,
        }).select('id').single();
        targetTable = 'calendar_events'; targetId = ev?.id ?? null;
      } else if (kind === 'reminder' || kind === 'task') {
        const { data: rem } = await sb.from('family_reminders').insert({
          family_id: familyId, created_by: userId,
          title: writeBackTitle(kind, plan.title),
          notes: plan.description ?? null,
          kind: kind === 'task' ? 'task' : 'reminder',
          remind_at: reminderLeadAt(plan.planned_for),
          ai_suggested: true,
        }).select('id').single();
        targetTable = 'family_reminders'; targetId = rem?.id ?? null;
      } else {
        continue;
      }

      await sb.from('concierge_plan_actions').insert({
        family_id: familyId, plan_id: planId, action_kind: kind,
        target_table: targetTable, target_id: targetId,
        detail: writeBackTitle(kind, plan.title), created_by: userId,
      });
      applied.push(kind);
    } catch {
      /* one failed write-back shouldn't abort the rest */
    }
  }

  revalidatePath('/dashboard/concierge');
  return { ok: true, applied };
}
