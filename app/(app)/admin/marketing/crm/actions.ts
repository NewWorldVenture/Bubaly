'use server';

import { revalidatePath } from 'next/cache';
import { requireMarketingAdmin, logMarketingAudit } from '@/lib/marketing/admin';
import { LEAD_STATUSES, LIFECYCLE_STAGES, DEAL_STAGES, type LeadStatus, type LifecycleStage, type DealStage } from '@/lib/marketing/crm';

function s(fd: FormData, k: string): string | null {
  const v = String(fd.get(k) ?? '').trim();
  return v === '' ? null : v;
}

// ── Contacts ───────────────────────────────────────────────────────────────
export async function saveContactAction(formData: FormData) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const id = s(formData, 'id');

  const lead_status = (s(formData, 'lead_status') ?? 'new') as LeadStatus;
  const lifecycle_stage = (s(formData, 'lifecycle_stage') ?? 'lead') as LifecycleStage;
  const row = {
    first_name: s(formData, 'first_name'),
    last_name: s(formData, 'last_name'),
    email: s(formData, 'email'),
    phone: s(formData, 'phone'),
    company: s(formData, 'company'),
    lead_status: LEAD_STATUSES.includes(lead_status) ? lead_status : 'new',
    lifecycle_stage: LIFECYCLE_STAGES.includes(lifecycle_stage) ? lifecycle_stage : 'lead',
    lead_source: s(formData, 'lead_source'),
    notes: s(formData, 'notes'),
  };

  if (id) {
    await supabase.from('crm_contacts').update(row).eq('id', id);
    await logMarketingAudit(supabase, { actorId, actorEmail, action: 'update', resource: 'crm_contact', resourceId: id });
  } else {
    const { data } = await supabase.from('crm_contacts').insert({ ...row, created_by: actorId }).select('id').single();
    await logMarketingAudit(supabase, { actorId, actorEmail, action: 'create', resource: 'crm_contact', resourceId: data?.id ?? null });
  }
  revalidatePath('/admin/marketing/crm');
}

export async function deleteContactAction(id: string) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  await supabase.from('crm_contacts').delete().eq('id', id);
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'delete', resource: 'crm_contact', resourceId: id });
  revalidatePath('/admin/marketing/crm');
}

// ── Deals ──────────────────────────────────────────────────────────────────
export async function saveDealAction(formData: FormData) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const id = s(formData, 'id');
  const name = s(formData, 'name');
  if (!name) return;

  const dollars = Number(s(formData, 'amount') ?? '0');
  const stage = (s(formData, 'stage') ?? 'lead') as DealStage;
  const row = {
    name,
    contact_id: s(formData, 'contact_id'),
    amount_cents: Number.isFinite(dollars) ? Math.round(dollars * 100) : 0,
    stage: DEAL_STAGES.includes(stage) ? stage : 'lead',
    close_date: s(formData, 'close_date'),
    notes: s(formData, 'notes'),
  };

  if (id) {
    await supabase.from('crm_deals').update(row).eq('id', id);
    await logMarketingAudit(supabase, { actorId, actorEmail, action: 'update', resource: 'crm_deal', resourceId: id });
  } else {
    const { data } = await supabase.from('crm_deals').insert({ ...row, created_by: actorId }).select('id').single();
    await logMarketingAudit(supabase, { actorId, actorEmail, action: 'create', resource: 'crm_deal', resourceId: data?.id ?? null });
  }
  revalidatePath('/admin/marketing/pipeline');
}

/** Move a deal to a new stage (used by the pipeline board's quick controls). */
export async function setDealStageAction(id: string, stage: string) {
  if (!DEAL_STAGES.includes(stage as DealStage)) return;
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  await supabase.from('crm_deals').update({ stage }).eq('id', id);
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'update', resource: 'crm_deal', resourceId: id, metadata: { stage } });
  revalidatePath('/admin/marketing/pipeline');
}

export async function deleteDealAction(id: string) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  await supabase.from('crm_deals').delete().eq('id', id);
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'delete', resource: 'crm_deal', resourceId: id });
  revalidatePath('/admin/marketing/pipeline');
}
