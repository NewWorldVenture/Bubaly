'use server';

import { revalidatePath } from 'next/cache';
import { requireMarketingAdmin, logMarketingAudit, marketingActionFailure } from '@/lib/marketing/admin';
import { sendPushToUsers } from '@/lib/server/push';
import { selectPushRecipients, canSendPush } from '@/lib/marketing/push';
import { readAll } from '@/lib/supabase/read-all';
import { readInChunks } from '@/lib/supabase/chunked-in';

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

  // Opted-in device owners. Paged: an unbounded select stops at PostgREST's
  // db-max-rows without a word, so past 1,000 devices a campaign would reach a
  // prefix of its audience and record `recipients` as if that were everyone.
  //
  // `id` breaks the tie. `push_devices` is one row per PHYSICAL device, so
  // `user_id` repeats for anyone with a phone and a laptop, and read-all.ts is
  // explicit that a paged read needs an order that is unique or "pages can
  // repeat and skip rows". Ordering by `user_id` alone is not a total order, so
  // the boundary between two separately-planned pages can move within a run of
  // equal ids — the same defect blog/posts.ts measured at 717 colliding rows.
  //
  // It is latent here rather than live, and that is worth stating plainly: only
  // rows INSIDE a tie group can be permuted, so the set of distinct `user_id`
  // values is the same either way, and `selectPushRecipients` dedupes to
  // exactly that set. What changes is the device rows, and the moment this read
  // grows a second column — a device_key, a per-device count, a platform
  // breakdown — the drop becomes the audience bug the comment above describes.
  const { rows: devices, error: deviceError } = await readAll<{ user_id: string }>((from, to) =>
    supabase.from('push_devices').select('user_id').eq('enabled', true).order('user_id').order('id').range(from, to));
  if (deviceError) await markFailedAndThrow(deviceError);
  const userIds = devices.map((d) => d.user_id);

  // Map user → email and pull the suppression list to exclude opted-out people.
  const uniqueIds = [...new Set(userIds.filter(Boolean))];
  const emailByUser: Record<string, string | null> = {};
  if (uniqueIds.length) {
    // Chunked, and for a reason created by the readAll three lines above: that
    // fix removed the 1,000-device cap, which is exactly what makes uniqueIds
    // unbounded here. One `.in()` runs about 40 bytes per id, so an audience of
    // a few hundred devices builds a query string past the gateway's
    // request-line limit and the whole campaign fails. Fixing the prefix read
    // is what made the next statement reachable at scale.
    const { data: profiles, error: profileError } = await readInChunks<
      { id: string; email: string | null }, { message: string }
    >(uniqueIds, (chunk) => supabase.from('profiles').select('id, email').in('id', chunk));
    if (profileError) await markFailedAndThrow(profileError);
    for (const p of profiles ?? []) emailByUser[p.id] = p.email;
  }
  // The suppression list MUST be read whole. `selectPushRecipients` excludes an
  // address only by finding its row, so a truncated read does not send fewer
  // messages — it sends to the people whose opt-out fell past the cap. Read
  // completeness is the opt-out here, which is why the write side of this table
  // is already guarded.
  const { rows: supp, error: suppressionError } = await readAll<{ email: string }>((from, to) =>
    supabase.from('marketing_suppressions').select('email').order('email').range(from, to));
  if (suppressionError) await markFailedAndThrow(suppressionError);
  const suppressed = supp.map((r) => r.email);

  const recipients = selectPushRecipients(userIds, emailByUser, suppressed);

  let result: { sent: number; skipped: number; failed: number; pruned: number } = { sent: 0, skipped: 0, failed: 0, pruned: 0 };
  try {
    result = recipients.length
      ? await sendPushToUsers(supabase, recipients, { title: campaign.title, body: campaign.body, url: campaign.url })
      : { sent: 0, skipped: 0, failed: 0, pruned: 0 };
  } catch (error) {
    await markFailedAndThrow(error);
  }

  const { data: sentCampaign, error: sentError } = await supabase.from('marketing_push_campaigns').update({
    status: 'sent',
    recipients: recipients.length,
    sent: result.sent,
    failed: result.failed,
    skipped: result.skipped,
    sent_at: new Date().toISOString(),
  }).eq('id', id).eq('status', 'sending').select('id').maybeSingle();
  if (sentError || !sentCampaign) marketingActionFailure('record push campaign delivery', sentError ?? new Error('Push campaign claim was lost before delivery could be recorded.'));

  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'send', resource: 'marketing_push_campaign', resourceId: id, metadata: { recipients: recipients.length, sent: result.sent } });
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
