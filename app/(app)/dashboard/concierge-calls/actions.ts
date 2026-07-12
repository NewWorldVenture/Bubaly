'use server';

import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { logAudit } from '@/lib/server/audit';
import { buildCallBrief, type CallTaskKind, type CallCategory } from '@/lib/concierge-calls/brief';
import type { Json } from '@/lib/database.types';

type Result<T = undefined> = { ok: true; data?: T } | { ok: false; error: string };

const TASK_KINDS = new Set(['book', 'reschedule', 'cancel', 'confirm', 'inquire', 'follow_up', 'other']);
const CATEGORIES = new Set(['medical', 'dental', 'school', 'restaurant', 'service', 'utility', 'retail', 'government', 'other']);
const PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);

/**
 * Request an outbound AI concierge call. Persists the task, generates the
 * deterministic call brief (talking points/questions/success/fallback), and
 * queues it — telephony is provider-gated, so it parks in 'queued' until a
 * provider places it (see /api/concierge-calls/place). Family-scoped RLS ensures
 * the caller can only write their own family's row.
 */
export async function requestCallAction(input: {
  taskKind: string; calleeName: string; calleePhone?: string; calleeCategory?: string;
  goal: string; priority?: string; scheduledFor?: string;
  details?: { memberName?: string; preferredTimes?: string; referenceNumber?: string; budget?: string; notes?: string };
}): Promise<Result<{ id: string }>> {
  const ctx = await requireUserContext();
  const supabase = await createServer();

  const calleeName = (input.calleeName ?? '').trim();
  const goal = (input.goal ?? '').trim();
  if (calleeName.length < 2) return { ok: false, error: 'Who should we call?' };
  if (goal.length < 4) return { ok: false, error: 'What should the call accomplish?' };

  const taskKind = (TASK_KINDS.has(input.taskKind) ? input.taskKind : 'inquire') as CallTaskKind;
  const calleeCategory = (CATEGORIES.has(input.calleeCategory ?? '') ? input.calleeCategory : 'other') as CallCategory;
  const priority = PRIORITIES.has(input.priority ?? '') ? input.priority! : 'normal';
  const details = {
    familyName: ctx.active.family.name?.replace(/ Family$/i, '').trim() || undefined,
    memberName: input.details?.memberName?.trim() || undefined,
    preferredTimes: input.details?.preferredTimes?.trim() || undefined,
    referenceNumber: input.details?.referenceNumber?.trim() || undefined,
    budget: input.details?.budget?.trim() || undefined,
    phone: input.calleePhone?.trim() || undefined,
    notes: input.details?.notes?.trim() || undefined,
  };

  const brief = buildCallBrief({ taskKind, calleeName, goal, details });
  // A phone number lets a configured provider actually dial; without one the
  // request still queues so the family can add the number / place it later.
  const status = input.calleePhone?.trim() ? 'queued' : 'draft';

  const { data, error } = await supabase.from('concierge_calls').insert({
    family_id: ctx.active.familyId,
    requested_by: ctx.active.member.id,
    task_kind: taskKind,
    callee_name: calleeName,
    callee_phone: input.calleePhone?.trim() || null,
    callee_category: calleeCategory,
    goal,
    details: details as unknown as Json,
    brief: brief as unknown as Json,
    status,
    priority,
    scheduled_for: input.scheduledFor || null,
    created_by: ctx.user.id,
  }).select('id').single();
  if (error || !data) return { ok: false, error: error?.message ?? 'Could not create the call request' };

  await logAudit(supabase, {
    familyId: ctx.active.familyId, actorId: ctx.user.id, action: 'create',
    resource: 'concierge_calls', resourceId: data.id, metadata: { taskKind, calleeName },
  });
  return { ok: true, data: { id: data.id } };
}

/** Cancel a pending/queued call request. */
export async function cancelCallAction(id: string): Promise<Result> {
  await requireUserContext();
  const supabase = await createServer();
  const { error } = await supabase.from('concierge_calls')
    .update({ status: 'cancelled' }).eq('id', id).in('status', ['draft', 'queued', 'action_needed']);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/** Re-queue a failed / needs-you call (optionally after adding a phone number). */
export async function requeueCallAction(id: string, phone?: string): Promise<Result> {
  await requireUserContext();
  const supabase = await createServer();
  const patch: { status: string; callee_phone?: string } = { status: 'queued' };
  if (phone?.trim()) patch.callee_phone = phone.trim();
  const { error } = await supabase.from('concierge_calls')
    .update(patch).eq('id', id).in('status', ['draft', 'failed', 'action_needed']);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
