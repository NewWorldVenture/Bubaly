import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { FROM_EMAIL, emailEnabled, APP_URL } from '@/lib/email';
import { getMarketingCustomers, evaluateSegment, type SegmentRules } from '@/lib/marketing/customers';
import { unsubUrl } from '@/lib/marketing/unsubscribe';

type DB = SupabaseClient<Database>;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_RECIPIENTS = 1000;

/** Resolve the deduped, valid, non-suppressed recipient list for a campaign. */
export async function resolveRecipients(
  supabase: DB,
  campaign: { segment_id: string | null },
): Promise<string[]> {
  const customers = await getMarketingCustomers(supabase);

  let pool = customers;
  if (campaign.segment_id) {
    const { data: seg } = await supabase.from('marketing_segments').select('rules').eq('id', campaign.segment_id).maybeSingle();
    if (seg) pool = evaluateSegment(customers, (seg.rules ?? {}) as SegmentRules);
  }

  const emails = new Set<string>();
  for (const c of pool) {
    const e = c.ownerEmail?.trim().toLowerCase();
    if (e && EMAIL_RE.test(e)) emails.add(e);
  }

  // Remove suppressed addresses (unsubscribes, bounces, complaints).
  if (emails.size > 0) {
    const { data: suppressed } = await supabase
      .from('marketing_suppressions')
      .select('email')
      .in('email', [...emails]);
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
  const { data: c, error } = await supabase.from('marketing_email_campaigns').select('*').eq('id', campaignId).maybeSingle();
  if (error || !c) throw new Error('Campaign not found');
  if (c.status === 'sent' || c.status === 'sending') throw new Error('Campaign already sent');
  if (!emailEnabled()) throw new Error('No email provider configured (set RESEND_API_KEY)');
  if (!c.subject?.trim()) throw new Error('Add a subject before sending');

  const recipients = await resolveRecipients(supabase, c);
  if (recipients.length === 0) throw new Error('No eligible recipients (after suppression/consent filtering)');

  await supabase.from('marketing_email_campaigns').update({ status: 'sending' }).eq('id', campaignId);

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

    const res = await fetch('https://api.resend.com/emails/batch', {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      console.error('[marketing send failed]', res.status, await res.text());
      await supabase.from('marketing_email_campaigns').update({ status: 'failed' }).eq('id', campaignId);
      throw new Error('Provider rejected the send');
    }
    sent += chunk.length;
  }

  await supabase.from('marketing_email_campaigns').update({
    status: 'sent', sent_at: new Date().toISOString(), recipients: sent,
  }).eq('id', campaignId);

  return { sent };
}
