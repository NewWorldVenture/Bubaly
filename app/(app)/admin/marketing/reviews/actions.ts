'use server';

import { revalidatePath } from 'next/cache';
import { requireMarketingAdmin, logMarketingAudit, marketingActionFailure } from '@/lib/marketing/admin';
import { isReviewStatus } from '@/lib/marketing/reviews';

function s(fd: FormData, k: string): string | null {
  const v = String(fd.get(k) ?? '').trim();
  return v === '' ? null : v;
}
function num(fd: FormData, k: string): number | null {
  const v = s(fd, k);
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function moderateReviewAction(id: string, status: string) {
  if (!isReviewStatus(status)) return;
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const { data, error } = await supabase.from('reviews').update({ status }).eq('id', id).select('id').maybeSingle();
  if (error || !data) marketingActionFailure('moderate the review', error ?? new Error('Review not found.'));
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'update', resource: 'review', resourceId: id, metadata: { status } });
  revalidatePath('/admin/marketing/reviews');
}

export async function replyToReviewAction(formData: FormData) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const id = s(formData, 'id');
  if (!id) return;
  const { data, error } = await supabase.from('reviews').update({
    reply: s(formData, 'reply'),
    replied_at: new Date().toISOString(),
    replied_by: actorId,
  }).eq('id', id).select('id').maybeSingle();
  if (error || !data) marketingActionFailure('reply to the review', error ?? new Error('Review not found.'));
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'reply', resource: 'review', resourceId: id });
  revalidatePath('/admin/marketing/reviews');
}

export async function deleteReviewAction(id: string) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const { data, error } = await supabase.from('reviews').update({ deleted_at: new Date().toISOString() })
    .eq('id', id).is('deleted_at', null).select('id').maybeSingle();
  if (error || !data) marketingActionFailure('delete the review', error ?? new Error('Review not found.'));
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'delete', resource: 'review', resourceId: id });
  revalidatePath('/admin/marketing/reviews');
}

export async function saveReputationSettingsAction(formData: FormData) {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const row = {
    singleton: true,
    google_url: s(formData, 'google_url'),
    app_store_url: s(formData, 'app_store_url'),
    play_store_url: s(formData, 'play_store_url'),
    trustpilot_url: s(formData, 'trustpilot_url'),
    request_headline: s(formData, 'request_headline'),
    request_message: s(formData, 'request_message'),
    thank_you_high: s(formData, 'thank_you_high'),
    thank_you_low: s(formData, 'thank_you_low'),
    min_public_rating: num(formData, 'min_public_rating') ?? 4,
    auto_approve_min: num(formData, 'auto_approve_min'),
    updated_by: actorId,
  };
  const { data, error } = await supabase.from('reputation_settings').upsert(row, { onConflict: 'singleton' })
    .select('singleton').single();
  if (error || !data) marketingActionFailure('save reputation settings', error ?? new Error('Reputation settings were not returned after save.'));
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'update', resource: 'reputation_settings' });
  revalidatePath('/admin/marketing/reviews');
}
