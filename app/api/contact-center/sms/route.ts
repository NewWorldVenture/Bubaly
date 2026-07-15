// Twilio inbound-SMS webhook for a family's dedicated Contact Center number.
// Files the text into the unified inbox, runs the AI concierge (summary + intent
// + reply), auto-replies via TwiML, and escalates genuine urgencies to the
// family's human fallback number. Signature-validated in production.

import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { validateTwilioSignature, sendSms } from '@/lib/guardian/twilio';
import { readBoundedRequestFormData } from '@/lib/server/bounded-request-body';
import { resolveFamilyByNumber, getOrCreateChannel, recordInboundMessage, recordOutboundMessage } from '@/lib/contact-center/server';
import { runConcierge } from '@/lib/contact-center/concierge';
import { shouldNotifyFamily, autoReplyText } from '@/lib/contact-center/routing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BASE_URL = (process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/$/, '');
const MAX_BODY = 64 * 1024;

function xml(body: string): NextResponse {
  return new NextResponse(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`, {
    status: 200, headers: { 'content-type': 'text/xml' },
  });
}
function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function POST(req: NextRequest) {
  const form = await readBoundedRequestFormData(req, MAX_BODY);
  if (!form.ok) return new NextResponse('Invalid callback', { status: form.reason === 'too_large' ? 413 : 400 });
  const params = Object.fromEntries(form.value.entries()) as Record<string, string>;

  if (process.env.NODE_ENV === 'production') {
    const sig = req.headers.get('x-twilio-signature') ?? '';
    if (!validateTwilioSignature(sig, `${BASE_URL}/api/contact-center/sms`, params)) {
      return new NextResponse('Unauthorized', { status: 401 });
    }
  }

  const from = params.From ?? null;
  const to = params.To ?? '';
  const body = (params.Body ?? '').slice(0, 4096);
  const sid = params.MessageSid ?? params.SmsSid ?? null;

  const admin = createServiceClient();
  const familyId = to ? await resolveFamilyByNumber(admin, to) : null;
  if (!familyId) return xml(''); // not one of our numbers

  const [channel, { data: fam }] = await Promise.all([
    getOrCreateChannel(admin, familyId),
    admin.from('families').select('name').eq('id', familyId).maybeSingle(),
  ]);
  const familyLabel = fam?.name || 'the family';

  const result = await runConcierge({ channel: 'sms', from: from ?? undefined, text: body, familyLabel });

  await recordInboundMessage(admin, {
    familyId, channel: 'sms', from: from ?? undefined, to, body,
    providerRef: sid ?? undefined, aiSummary: result.summary, aiIntent: result.intent,
  });

  // Escalate genuine urgencies to the family's human fallback.
  if (shouldNotifyFamily(result.intent) && channel?.forward_to_phone) {
    try { await sendSms(channel.forward_to_phone, `🚨 Urgent at your Bubaly line: ${result.summary}`); } catch { /* best-effort */ }
    try {
      await admin.from('notifications').insert({
        family_id: familyId, type: 'system',
        title: '🚨 Urgent message at your family line', body: result.summary,
        related_type: 'contact_center',
      });
    } catch { /* notifications shape may vary — best-effort */ }
  }

  // Auto-reply unless the concierge is off or it's spam.
  if (channel?.ai_concierge_enabled !== false && result.intent !== 'spam') {
    const reply = result.reply || autoReplyText(result.intent, familyLabel);
    await recordOutboundMessage(admin, { familyId, channel: 'sms', to: from ?? undefined, body: reply });
    return xml(`<Message>${escapeXml(reply)}</Message>`);
  }
  return xml('');
}
