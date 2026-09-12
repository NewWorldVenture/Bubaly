'use server';

import { revalidatePath } from 'next/cache';
import { randomUUID } from 'node:crypto';
import type { Json } from '@/lib/database.types';
import { requireMarketingAdmin, logMarketingAudit, marketingActionFailure } from '@/lib/marketing/admin';
import { sendPushToUsers, PushPreparationError, type PushResult } from '@/lib/server/push';
import { canSendPush, canDeletePush } from '@/lib/marketing/push';
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

/** Broadcast under a durable claim. Whole-campaign retries require proof of no dispatch. */
export async function sendPushCampaignAction(id: string): Promise<void> {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const { data: campaign, error: campaignError } = await supabase
    .from('marketing_push_campaigns').select('*')
    .eq('id', id).is('deleted_at', null).maybeSingle();
  if (campaignError) marketingActionFailure('load the push campaign', campaignError);
  if (!campaign || !canSendPush(campaign.status, campaign.metadata)) return;

  const attemptId = randomUUID();
  const baseline = campaign.metadata && typeof campaign.metadata === 'object' && !Array.isArray(campaign.metadata)
    ? campaign.metadata : {};
  const receipt = (phase: string, extra: Record<string, Json> = {}) => ({
    ...baseline, push_delivery: { version: 1, attemptId, phase, ...extra },
  });
  const claim = { push_delivery: { attemptId } };
  const { data: reserved, error: reserveError } = await supabase.from('marketing_push_campaigns')
    .update({ status: 'sending', metadata: receipt('preparing') })
    .eq('id', id).eq('status', campaign.status).eq('updated_at', campaign.updated_at)
    .is('deleted_at', null).select('id').maybeSingle();
  if (reserveError) marketingActionFailure('reserve the push campaign', reserveError);
  if (!reserved) return;

  let enteredProviderBoundary = false;
  const markFailure = async (error: unknown): Promise<never> => {
    const safeToRetry = !enteredProviderBoundary || error instanceof PushPreparationError;
    const { data: failed, error: failedError } = await supabase.from('marketing_push_campaigns')
      .update({
        status: safeToRetry ? 'failed' : 'sending',
        metadata: receipt(safeToRetry ? 'preflight_failed' : 'unknown', {
          finishedAt: new Date().toISOString(),
        }),
      }).eq('id', id).eq('status', 'sending').contains('metadata', claim)
      .select('id').maybeSingle();
    if (failedError || !failed) console.error('[marketing push] outcome-state update failed');
    revalidatePath('/admin/marketing/push');
    marketingActionFailure('send the push campaign', error);
  };

  let recipients: string[] = [];
  let result: PushResult = { sent: 0, skipped: 0, failed: 0, pruned: 0, withheld: 0 };
  try {
    recipients = await loadPushCampaignAudience(supabase);
    const { data: dispatching, error: dispatchError } = await supabase.from('marketing_push_campaigns')
      .update({ metadata: receipt('dispatching', { recipientUsers: recipients.length }) })
      .eq('id', id).eq('status', 'sending').is('deleted_at', null).contains('metadata', claim)
      .select('id').maybeSingle();
    if (dispatchError || !dispatching) throw new Error('The campaign dispatch claim could not be saved.');
    // Once this boundary is entered, only the sender's explicit preparation
    // error can prove that no device request has been dispatched.
    enteredProviderBoundary = true;
    if (recipients.length) result = await sendPushToUsers(supabase, recipients, {
      title: campaign.title, body: campaign.body, url: campaign.url,
    });
    if (![result.sent, result.skipped, result.failed, result.pruned, result.withheld]
      .every(value => Number.isSafeInteger(value) && value >= 0)) {
      throw new Error('The push sender could not confirm complete outcome counts.');
    }
    // Recipient opt-outs are intentional exclusions, not delivery failures.
    const complete = result.failed === 0 && result.skipped === 0 && result.pruned === 0;
    const { data: saved, error: saveError } = await supabase.from('marketing_push_campaigns').update({
      status: complete ? 'sent' : 'failed',
      recipients: recipients.length, sent: result.sent, failed: result.failed,
      skipped: result.skipped + result.withheld,
      sent_at: result.sent > 0 ? new Date().toISOString() : null,
      metadata: receipt(recipients.length === 0 ? 'no_recipients' : complete ? 'complete' : 'review', {
        recipientUsers: recipients.length, withheldUsers: result.withheld,
        skippedDevices: result.skipped, prunedDevices: result.pruned,
        confirmedDeviceAcceptances: result.sent, failedDeviceOperations: result.failed,
        finishedAt: new Date().toISOString(),
      }),
    }).eq('id', id).eq('status', 'sending').contains('metadata', claim).select('id').maybeSingle();
    if (saveError || !saved) throw new Error('Push campaign results could not be saved.');
  } catch (error) {
    return markFailure(error);
  }
  await logMarketingAudit(supabase, {
    actorId, actorEmail, action: 'send', resource: 'marketing_push_campaign', resourceId: id,
    metadata: { attemptId, recipients: recipients.length, sent: result.sent, failed: result.failed,
      withheld: result.withheld, deviceSkipped: result.skipped, pruned: result.pruned },
  });
  revalidatePath('/admin/marketing/push');
}

export async function deletePushCampaignAction(id: string): Promise<void> {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const { data: campaign, error: readError } = await supabase.from('marketing_push_campaigns')
    .select('status,metadata,updated_at').eq('id', id).is('deleted_at', null).maybeSingle();
  if (readError) marketingActionFailure('load the push campaign', readError);
  if (!campaign || !canDeletePush(campaign.status, campaign.metadata)) return;
  const { data, error } = await supabase.from('marketing_push_campaigns').update({ deleted_at: new Date().toISOString() })
    .eq('id', id).eq('status', campaign.status).eq('updated_at', campaign.updated_at)
    .is('deleted_at', null).select('id').maybeSingle();
  if (error) marketingActionFailure('delete the push campaign', error);
  if (!data) return;
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'delete', resource: 'marketing_push_campaign', resourceId: id });
  revalidatePath('/admin/marketing/push');
}
