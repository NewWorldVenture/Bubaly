'use server';

import { revalidatePath } from 'next/cache';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';

/** Log a visit / call / gift / favor / note against a contact. */
export async function logInteractionAction(formData: FormData): Promise<void> {
  const contactId = String(formData.get('contact_id') ?? '');
  const kind = String(formData.get('kind') ?? 'note');
  const title = String(formData.get('title') ?? '').trim();
  const note = String(formData.get('note') ?? '').trim() || null;
  const occurredOn = String(formData.get('occurred_on') ?? '') || new Date().toISOString().slice(0, 10);
  const amountRaw = String(formData.get('amount') ?? '').trim();
  const amount = amountRaw ? Number(amountRaw) : null;
  if (!contactId || !title) return;

  const ctx = await requireUserContext();
  const supabase = await createServer();
  await supabase.from('contact_interactions').insert({
    family_id: ctx.active.familyId,
    contact_id: contactId,
    kind: ['visit', 'call', 'message', 'gift', 'favor', 'note'].includes(kind) ? kind : 'note',
    occurred_on: occurredOn,
    title: title.slice(0, 200),
    note,
    amount: Number.isFinite(amount as number) ? amount : null,
    created_by: ctx.user.id,
  });
  revalidatePath(`/dashboard/contacts/${contactId}`);
}

/** Remove a logged interaction (family-scoped). */
export async function deleteInteractionAction(input: { id: string; contactId: string }): Promise<void> {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  await supabase.from('contact_interactions')
    .delete().eq('id', input.id).eq('family_id', ctx.active.familyId);
  revalidatePath(`/dashboard/contacts/${input.contactId}`);
}
