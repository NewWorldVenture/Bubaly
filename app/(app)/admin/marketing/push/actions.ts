'use server';

import { revalidatePath } from 'next/cache';
import { requireMarketingAdmin, logMarketingAudit } from '@/lib/marketing/admin';
import { sendPushToUsers } from '@/lib/server/push';
import { selectPushRecipients, canSendPush } from '@/lib/marketing/push';

function s(fd: FormData, k: string): string | null {
  const v = String(fd.get(k) ?? '').trim();
  return v === '' ? null : v;
}

export async function createPushCampaignAction(formData: FormData): Promise<void> {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  const title = s(formData, 'title');
  if (!title) return;
  const { data } = await supabase.from('marketing_push_campaigns').insert({
    title,
    body: s(formData, 'body'),
    url: s(formData, 'url'),
    created_by: actorId,
  }).select('id').single();
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'create', resource: 'marketing_push_campaign', resourceId: data?.id ?? null, metadata: { title } });
  revalidatePath('/admin/marketing/push');
}

/** Broadcast a draft campaign to every opted-in device (minus suppressed emails). */
export async function sendPushCampaignAction(id: string): Promise<void> {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();

  const { data: campaign } = await supabase
    .from('marketing_push_campaigns')
    .select('id, title, body, url, status')
    .eq('id', id)
    .is('deleted_at', null)
    .maybeSingle();
  if (!campaign || !canSendPush(campaign.status)) return;

  // Reserve immediately so a double-click can't double-send.
  await supabase.from('marketing_push_campaigns').update({ status: 'sending' }).eq('id', id);

  // Opted-in device owners.
  const { data: devices } = await supabase
    .from('push_devices')
    .select('user_id')
    .eq('enabled', true);
  const userIds = (devices ?? []).map((d) => d.user_id);

  // Map user → email and pull the suppression list to exclude opted-out people.
  const uniqueIds = [...new Set(userIds.filter(Boolean))];
  const emailByUser: Record<string, string | null> = {};
  if (uniqueIds.length) {
    const { data: profiles } = await supabase.from('profiles').select('id, email').in('id', uniqueIds);
    for (const p of profiles ?? []) emailByUser[p.id] = p.email;
  }
  const { data: supp } = await supabase.from('marketing_suppressions').select('email');
  const suppressed = (supp ?? []).map((r) => r.email);

  const recipients = selectPushRecipients(userIds, emailByUser, suppressed);

  const result = recipients.length
    ? await sendPushToUsers(supabase, recipients, { title: campaign.title, body: campaign.body, url: campaign.url })
    : { sent: 0, skipped: 0, failed: 0, pruned: 0 };

  await supabase.from('marketing_push_campaigns').update({
    status: 'sent',
    recipients: recipients.length,
    sent: result.sent,
    failed: result.failed,
    skipped: result.skipped,
    sent_at: new Date().toISOString(),
  }).eq('id', id);

  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'send', resource: 'marketing_push_campaign', resourceId: id, metadata: { recipients: recipients.length, sent: result.sent } });
  revalidatePath('/admin/marketing/push');
}

export async function deletePushCampaignAction(id: string): Promise<void> {
  const { supabase, actorId, actorEmail } = await requireMarketingAdmin();
  await supabase.from('marketing_push_campaigns').update({ deleted_at: new Date().toISOString() }).eq('id', id);
  await logMarketingAudit(supabase, { actorId, actorEmail, action: 'delete', resource: 'marketing_push_campaign', resourceId: id });
  revalidatePath('/admin/marketing/push');
}
