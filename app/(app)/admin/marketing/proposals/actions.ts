'use server';

import { revalidatePath } from 'next/cache';
import { requireMarketingAdmin, logMarketingAudit, marketingActionFailure } from '@/lib/marketing/admin';
import { isQuoteStatus, type QuoteStatus } from '@/lib/marketing/quotes';

function s(fd: FormData, k: string): string | null {
  const v = String(fd.get(k) ?? '').trim();
  return v === '' ? null : v;
}

export async function saveQuoteAction(formData: FormData) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const id = s(formData, 'id');
  const title = s(formData, 'title');
  if (!title) return;

  const dollars = Number(s(formData, 'amount') ?? '0');
  const status = (s(formData, 'status') ?? 'draft') as QuoteStatus;
  const row = {
    title,
    contact_id: s(formData, 'contact_id'),
    amount_cents: Number.isFinite(dollars) ? Math.round(dollars * 100) : 0,
    status: isQuoteStatus(status) ? status : 'draft',
    valid_until: s(formData, 'valid_until'),
    notes: s(formData, 'notes'),
  };

  if (id) {
    const { data, error } = await supabase.from('crm_quotes').update(row).eq('id', id).select('id').maybeSingle();
    if (error || !data) marketingActionFailure('update the CRM quote', error ?? new Error('CRM quote not found'));
    await logMarketingAudit(supabase, { actorId, actorEmail, action: 'update', resource: 'crm_quote', resourceId: id });
  } else {
    const { data, error } = await supabase.from('crm_quotes').insert({ ...row, created_by: actorId }).select('id').single();
    if (error || !data) marketingActionFailure('create the CRM quote', error ?? new Error('No CRM quote was created'));
    await logMarketingAudit(supabase, { actorId, actorEmail, action: 'create', resource: 'crm_quote', resourceId: data.id });
  }
  revalidatePath('/admin/marketing/proposals');
}

/** Move a quote through its lifecycle; stamps sent_at / responded_at. */
export async function setQuoteStatusAction(id: string, status: string) {
  if (!isQuoteStatus(status)) return;
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const now = new Date().toISOString();
  const patch: { status: QuoteStatus; sent_at?: string; responded_at?: string } = { status };
  if (status === 'sent') patch.sent_at = now;
  if (status === 'accepted' || status === 'declined') patch.responded_at = now;
  const { data, error } = await supabase.from('crm_quotes').update(patch).eq('id', id).select('id').maybeSingle();
  if (error || !data) marketingActionFailure('update the CRM quote status', error ?? new Error('CRM quote not found'));
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'update', resource: 'crm_quote', resourceId: id, metadata: { status } });
  revalidatePath('/admin/marketing/proposals');
}

export async function deleteQuoteAction(id: string) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const { data, error } = await supabase.from('crm_quotes').delete().eq('id', id).select('id').maybeSingle();
  if (error || !data) marketingActionFailure('delete the CRM quote', error ?? new Error('CRM quote not found'));
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'delete', resource: 'crm_quote', resourceId: id });
  revalidatePath('/admin/marketing/proposals');
}
