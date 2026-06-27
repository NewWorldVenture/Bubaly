'use server';

import { revalidatePath } from 'next/cache';
import { requireMarketingAdmin, logMarketingAudit } from '@/lib/marketing/admin';
import { normalizeAffiliateCode, clampRate } from '@/lib/marketing/affiliates';

function s(fd: FormData, k: string): string | null {
  const v = String(fd.get(k) ?? '').trim();
  return v === '' ? null : v;
}

export async function saveAffiliateAction(formData: FormData) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const id = s(formData, 'id');
  const name = s(formData, 'name');
  if (!name) return;

  const codeRaw = s(formData, 'code') ?? name;
  const row = {
    name,
    email: s(formData, 'email'),
    code: normalizeAffiliateCode(codeRaw) || 'PARTNER',
    commission_rate: clampRate(Number(s(formData, 'commission_rate') ?? '20')),
    status: s(formData, 'status') === 'paused' ? 'paused' : 'active',
    notes: s(formData, 'notes'),
  };

  if (id) {
    await supabase.from('affiliates').update(row).eq('id', id);
    await logMarketingAudit(supabase, { actorId, actorEmail, action: 'update', resource: 'affiliate', resourceId: id });
  } else {
    const { data } = await supabase.from('affiliates').insert({ ...row, created_by: actorId }).select('id').single();
    await logMarketingAudit(supabase, { actorId, actorEmail, action: 'create', resource: 'affiliate', resourceId: data?.id ?? null });
  }
  revalidatePath('/admin/marketing/affiliates');
}

export async function toggleAffiliateStatusAction(id: string, status: string) {
  const next = status === 'paused' ? 'paused' : 'active';
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  await supabase.from('affiliates').update({ status: next }).eq('id', id);
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'update', resource: 'affiliate', resourceId: id, metadata: { status: next } });
  revalidatePath('/admin/marketing/affiliates');
}

export async function deleteAffiliateAction(id: string) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  await supabase.from('affiliates').delete().eq('id', id);
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'delete', resource: 'affiliate', resourceId: id });
  revalidatePath('/admin/marketing/affiliates');
}

/** Mark an affiliate's converted referrals as paid (settle payout). */
export async function markAffiliatePaidAction(affiliateId: string) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  await supabase.from('affiliate_referrals')
    .update({ status: 'paid', paid_at: new Date().toISOString() })
    .eq('affiliate_id', affiliateId).eq('status', 'converted');
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'payout', resource: 'affiliate', resourceId: affiliateId });
  revalidatePath('/admin/marketing/affiliates');
}
