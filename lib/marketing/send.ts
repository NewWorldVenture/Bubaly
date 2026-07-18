import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { FROM_EMAIL, emailEnabled, APP_URL } from '@/lib/email';
import { getMarketingCustomersWithError, evaluateSegment, type SegmentRules } from '@/lib/marketing/customers';
import { unsubUrl } from '@/lib/marketing/unsubscribe';
import { readBoundedResponseText } from '@/lib/server/bounded-response-body';
import { fetchExternal } from '@/lib/server/external-fetch';

type DB = SupabaseClient<Database>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_RECIPIENTS = 1000;

/** Resolve the deduped, valid, non-suppressed recipient list for a campaign. */
export async function resolveRecipients(
  supabase: DB,
  campaign: { segment_id: string | null },
): Promise<string[]> {
  const customerResult = await getMarketingCustomersWithError(supabase);
  if (customerResult.error) throw new Error('Could not load marketing customers for this campaign.');
  const customers = customerResult.customers;

  let pool = customers;
  if (campaign.segment_id) {
    const { data: seg, error: segmentError } = await supabase.from('marketing_segments')
      .select('rules').eq('id', campaign.segment_id).is('deleted_at', null).maybeSingle();
    if (segmentError) throw new Error('Could not load the campaign audience segment.');
    if (!seg) throw new Error('The campaign audience segment no longer exists.');
    pool = evaluateSegment(customers, (seg.rules ?? {}) as SegmentRules);
  }

  const emails = new Set<string>();
  for (const c of pool) {
    const e = c.ownerEmail?.trim().toLowerCase();
    if (e && EMAIL_RE.test(e)) emails.add(e);
  }

  // Remove suppressed addresses (unsubscribes, bounces, complaints).
  if (emails.size > 0) {
    const { data: suppressed, error: suppressionError } = await supabase
      .from('marketing_suppressions')
      .select('email')
      .in('email', [...emails]);
    if (suppressionError) throw new Error('Could not load marketing suppression preferences.');
    for (const s of suppressed ?? []) emails.delete(s.email);
  }

  return [...emails].slice(0, MAX_RECIPIENTS);
}

function footer(appUrl: string, email: string): string {
  const url = unsubUrl(appUrl, email);
  return `<hr style="margin-top:32px;border:none;border-top:1px solid #e5e7eb" /><p style="color:#9ca3af;font-size:12px;line-height:18px;margin-top:16px">You're receiving this because you have a Bubaly account. <a href="${url}" style="color:#6b7280">Unsubscribe</a>.</p>`;
}

type SendResult = { sent: number };

/**
 * Sends a marketing email campaign for real via the Resend batch API. Never
 * fakes a send: throws if no provider key, no recipients, or already sent.
 * Tags each message with the campaign id so the Resend webhook can attribute
 * opens/clicks, and includes a working unsubscribe link + List-Unsubscribe header.
 */
export async function sendEmailCampaign(supabase: DB, campaignId: string, appUrl = APP_URL): Promise<SendResult> {
  const { data: c, error } = await supabase.from('marketing_email_campaigns')
    .select('*').eq('id', campaignId).is('deleted_at', null).maybeSingle();
  if (error) throw new Error('Could not load the email campaign.');
  if (!c) throw new Error('Campaign not found.');
  if (c.status === 'sent' || c.status === 'sending') throw new Error('Campaign already sent');
  if (!emailEnabled()) throw new Error('No email provider configured (set RESEND_API_KEY)');
  if (!c.subject?.trim()) throw new Error('Add a subject before sending');

  const recipients = await resolveRecipients(supabase, c);
  if (recipients.length === 0) throw new Error('No eligible recipients (after suppression/consent filtering)');

  // Reserve the row atomically. A second browser tab or retried request must
  // never be able to send the same campaign concurrently.
  const { data: reserved, error: reserveError } = await supabase.from('marketing_email_campaigns')
    .update({ status: 'sending' })
    .eq('id', campaignId)
    .is('deleted_at', null)
    .in('status', ['draft', 'failed'])
    .select('id')
    .maybeSingle();
  if (reserveError) throw new Error('Could not reserve the email campaign for sending.');
  if (!reserved) throw new Error('Campaign is already sending, sent, or no longer available.');

  const from = c.from_name ? `${c.from_name} <${FROM_EMAIL.replace(/^.*</, '').replace(/>$/, '')}>` : FROM_EMAIL;
  const baseHtml = c.body_html?.trim() || `<p>${(c.preview_text ?? '').replace(/</g, '&lt;')}</p>`;

  // Resend batch API: up to 100 messages per request.
  let sent = 0;
  for (let i = 0; i < recipients.length; i += 100) {
    const chunk = recipients.slice(i, i + 100);
    const payload = chunk.map((to) => ({
      from,
      to,
      subject: c.subject,
      html: `${baseHtml}${footer(appUrl, to)}`,
      headers: { 'List-Unsubscribe': `<${unsubUrl(appUrl, to)}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
      tags: [{ name: 'campaign', value: campaignId }],
    }));

    const res = await fetchExternal('https://api.resend.com/emails/batch', {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }, 15_000);

    if (!res.ok) {
      const bounded = await readBoundedResponseText(res, 64 * 1024);
      console.error('[marketing send failed]', res.status, bounded.ok ? bounded.text : '[provider error response exceeded 64 KiB]');
      const { data: failed, error: failedError } = await supabase.from('marketing_email_campaigns')
        .update({ status: 'failed' }).eq('id', campaignId).eq('status', 'sending').select('id').maybeSingle();
      if (failedError || !failed) console.error('[marketing send] failed-state update failed', failedError ?? new Error('Campaign claim was lost.'));
      throw new Error(failedError || !failed
        ? 'Provider rejected the send and the campaign status could not be updated.'
        : 'Provider rejected the send');
    }
    sent += chunk.length;
  }

  const { data: sentCampaign, error: sentError } = await supabase.from('marketing_email_campaigns').update({
    status: 'sent', sent_at: new Date().toISOString(), recipients: sent,
  }).eq('id', campaignId).eq('status', 'sending').select('id').maybeSingle();
  if (sentError || !sentCampaign) {
    console.error('[marketing send] delivery-state update failed', sentError ?? new Error('Campaign claim was lost after provider acceptance.'));
    throw new Error('Provider accepted the send, but delivery state could not be recorded. Do not retry until the campaign is checked.');
  }

  return { sent };
}
