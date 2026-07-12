'use server';

import { revalidatePath } from 'next/cache';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { triagePaperwork, type PaperworkAction } from '@/lib/paperwork/triage';

const PATH = '/dashboard/paperwork';

/** Paste/capture a piece of paperwork → triage it → drop it in the inbox. */
export async function addPaperworkAction(formData: FormData): Promise<void> {
  const text = String(formData.get('text') ?? '').trim();
  const sender = String(formData.get('sender') ?? '').trim() || null;
  if (!text) return;

  const ctx = await requireUserContext();
  const supabase = await createServer();
  const t = triagePaperwork(text);

  await supabase.from('paperwork_items').insert({
    family_id: ctx.active.familyId,
    kind: t.kind,
    title: t.title,
    summary: t.summary,
    raw_text: text.slice(0, 20_000),
    sender,
    due_on: t.due_on,
    amount: t.amount,
    urgency: t.urgency,
    status: 'needs_action',
    actions: t.actions.map((a) => ({ ...a, materialized_as: null, materialized_id: null })),
    created_by: ctx.user.id,
  });
  revalidatePath(PATH);
}

type StoredAction = PaperworkAction & { materialized_as: string | null; materialized_id: string | null };

/**
 * One-tap materialization: turn an extracted action into a REAL record — a
 * calendar event (schedule/rsvp) or a family reminder (sign/pay/provide/review).
 * The action's materialization state is stamped back onto the paperwork row so
 * tapping twice never double-creates, and the link is auditable.
 */
export async function materializePaperworkActionAction(input: {
  itemId: string;
  actionIndex: number;
}): Promise<void> {
  const ctx = await requireUserContext();
  const supabase = await createServer();

  const { data: item } = await supabase
    .from('paperwork_items').select('*')
    .eq('id', input.itemId).eq('family_id', ctx.active.familyId).maybeSingle();
  if (!item) return;

  const actions = (Array.isArray(item.actions) ? item.actions : []) as unknown as StoredAction[];
  const action = actions[input.actionIndex];
  if (!action || action.materialized_id) return; // unknown or already materialized

  const dueOn = action.due_on ?? item.due_on;
  let materializedAs: 'calendar_event' | 'reminder';
  let materializedId: string | null = null;

  if (action.kind === 'schedule' || action.kind === 'rsvp') {
    // Calendar event at 9:00 local-naive on the due date (or a week out if undated).
    const startsAt = dueOn
      ? `${dueOn}T09:00:00`
      : new Date(Date.now() + 7 * 86_400_000).toISOString();
    const { data } = await supabase.from('calendar_events').insert({
      family_id: ctx.active.familyId,
      title: `${item.title}`.slice(0, 200),
      description: `From Paperwork Inbox — ${action.label}. ${item.summary ?? ''}`.trim().slice(0, 500),
      category: item.kind === 'sports' ? 'sports' : item.kind === 'medical_form' ? 'appointment' : 'school',
      starts_at: startsAt,
      all_day: Boolean(dueOn),
      created_by: ctx.user.id,
    }).select('id').single();
    materializedAs = 'calendar_event';
    materializedId = data?.id ?? null;
  } else {
    const amountBit = action.amount != null ? ` ($${action.amount})` : '';
    const { data } = await supabase.from('family_reminders').insert({
      family_id: ctx.active.familyId,
      created_by: ctx.user.id,
      title: `${action.label}${amountBit} — ${item.title}`.slice(0, 200),
      notes: `From Paperwork Inbox${item.sender ? ` · ${item.sender}` : ''}${dueOn ? ` · due ${dueOn}` : ''}`,
      kind: 'task',
      priority: item.urgency === 'urgent' ? 'high' : 'normal',
      status: 'pending',
      ai_suggested: true,
    }).select('id').single();
    materializedAs = 'reminder';
    materializedId = data?.id ?? null;
  }

  if (materializedId) {
    const next = actions.map((a, i) =>
      i === input.actionIndex ? { ...a, materialized_as: materializedAs, materialized_id: materializedId } : a);
    const allDone = next.every((a) => a.materialized_id);
    await supabase.from('paperwork_items')
      .update({ actions: next as never, status: allDone ? 'done' : 'in_progress' })
      .eq('id', item.id);
  }
  revalidatePath(PATH);
}

/** Move a paperwork item between statuses (done / archived / reopen). */
export async function setPaperworkStatusAction(input: {
  itemId: string;
  status: 'needs_action' | 'in_progress' | 'done' | 'archived';
}): Promise<void> {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  await supabase.from('paperwork_items')
    .update({ status: input.status })
    .eq('id', input.itemId).eq('family_id', ctx.active.familyId);
  revalidatePath(PATH);
}
