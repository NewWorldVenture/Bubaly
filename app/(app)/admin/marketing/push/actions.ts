'use server';

import { revalidatePath } from 'next/cache';
import { requireMarketingAdmin, logMarketingAudit, marketingActionFailure } from '@/lib/marketing/admin';
import { sendPushToUsers, type PushResult } from '@/lib/server/push';
import { canSendPush } from '@/lib/marketing/push';
import { loadPushCampaignAudience } from '@/lib/marketing/push-audience';

function s(fd: FormData, k: string): string | null {
  const v = String(fd.get(k) ?? '').trim();
  return v === '' ? null : v;
}

export async function createPushCampaignAction(formData: FormData): Promise<void> {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const title = s(formData, 'title');
  if (!title) return;
  const { data, error } = await supabase.from('marketing_push_campaigns').insert({
    title,
    body: s(formData, 'body'),
    url: s(formData, 'url'),
    created_by: actorId,
  }).select('id').single();
  if (error || !data) marketingActionFailure('create the push campaign', error ?? new Error('The push campaign row was not returned after save.'));
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'create', resource: 'marketing_push_campaign', resourceId: data.id, metadata: { title } });
  revalidatePath('/admin/marketing/push');
}

/** Broadcast a draft campaign to every opted-in device (minus suppressed emails). */
export async function sendPushCampaignAction(id: string): Promise<void> {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();

  const { data: campaign, error: campaignError } = await supabase
    .from('marketing_push_campaigns')
    .select('id, title, body, url, status')
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle();
  if (campaignError) marketingActionFailure('load the push campaign', campaignError);
  if (!campaign || !canSendPush(campaign.status)) return;

  // Claim only a draft/failed campaign so concurrent sends cannot double-deliver.
  const { data: reserved, error: reserveError } = await supabase.from('marketing_push_campaigns')
    .update({ status: 'sending' }).eq('id', id).eq('status', campaign.status).select('id').maybeSingle();
  if (reserveError) marketingActionFailure('reserve the push campaign', reserveError);
  if (!reserved) return;

  const markFailedAndThrow = async (error: unknown): Promise<never> => {
    const { data: failed, error: failedError } = await supabase.from('marketing_push_campaigns')
      .update({ status: 'failed' }).eq('id', id).eq('status', 'sending').select('id').maybeSingle();
    if (failedError || !failed) console.error('[marketing push] failed-state update failed', failedError ?? new Error('Campaign claim was lost.'));
    marketingActionFailure('send the push campaign', error);
  };

  let recipients: string[] = [];
  let result: PushResult = { sent: 0, skipped: 0, failed: 0, pruned: 0, withheld: 0 };
  try {
    recipients = await loadPushCampaignAudience(supabase);
    result = recipients.length
      ? await sendPushToUsers(supabase, recipients, { title: campaign.title, body: campaign.body, url: campaign.url })
      : { sent: 0, skipped: 0, failed: 0, pruned: 0, withheld: 0 };
  } catch (error) {
    await markFailedAndThrow(error);
  }

  const { data: sentCampaign, error: sentError } = await supabase.from('marketing_push_campaigns').update({
    status: 'sent',
    recipients: recipients.length,
    sent: result.sent,
    failed: result.failed,
    // Existing storage has one skipped column; the audit retains the reason.
    skipped: result.skipped + result.withheld,
    sent_at: new Date().toISOString(),
  }).eq('id', id).eq('status', 'sending').select('id').maybeSingle();
  if (sentError || !sentCampaign) marketingActionFailure('record push campaign delivery', sentError ?? new Error('Push campaign claim was lost before delivery could be recorded.'));

  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'send', resource: 'marketing_push_campaign', resourceId: id, metadata: { recipients: recipients.length, sent: result.sent, withheld: result.withheld, deviceSkipped: result.skipped } });
  revalidatePath('/admin/marketing/push');
}

export async function deletePushCampaignAction(id: string): Promise<void> {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const { data, error } = await supabase.from('marketing_push_campaigns').update({ deleted_at: new Date().toISOString() })
    .eq('id', id).is('deleted_at', null).select('id').maybeSingle();
  if (error || !data) marketingActionFailure('delete the push campaign', error ?? new Error('Push campaign not found.'));
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'delete', resource: 'marketing_push_campaign', resourceId: id });
  revalidatePath('/admin/marketing/push');
}
