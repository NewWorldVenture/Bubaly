// Twilio inbound-SMS webhook for a family's dedicated Contact Center number.
// Files the text into the unified inbox, runs the AI concierge (summary + intent
// + reply), auto-replies via TwiML, and escalates genuine urgencies to the
// family's human fallback number. Signature-validated in production.

import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { settle } from '@/lib/supabase/settle';
import { validateTwilioSignature, sendSms } from '@/lib/guardian/twilio';
import { readBoundedRequestFormData } from '@/lib/server/bounded-request-body';
import { resolveFamilyByNumberResult, getOrCreateChannelResult, recordInboundMessage, recordOutboundMessage, routeInboundToPlanner } from '@/lib/contact-center/server';
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
  const routed = to ? await resolveFamilyByNumberResult(admin, to) : { familyId: null, error: null };
  if (routed.error) {
    console.error('[contact-center] SMS routing read failed', routed.error);
    return new NextResponse('Routing temporarily unavailable', { status: 503 });
  }
  const familyId = routed.familyId;
  if (!familyId) return xml(''); // not one of our numbers

  const [channelResult, familyResult] = await Promise.all([
    getOrCreateChannelResult(admin, familyId),
    settle(admin.from('families').select('name').eq('id', familyId).maybeSingle()),
  ]);
  if (channelResult.error || familyResult.error) {
    console.error('[contact-center] SMS family context read failed', channelResult.error ?? familyResult.error);
    return new NextResponse('Contact Center temporarily unavailable', { status: 503 });
  }
  const channel = channelResult.data;
  const familyLabel = familyResult.data?.name || 'the family';

  const result = await runConcierge({ channel: 'sms', from: from ?? undefined, text: body, familyLabel });

  const filed = await recordInboundMessage(admin, {
    familyId, channel: 'sms', from: from ?? undefined, to, body,
    providerRef: sid ?? undefined, aiSummary: result.summary, aiIntent: result.intent,
  });

  // Urgency must reach the human before any planner/replay read can fail.
  // Only the original insertion escalates, so a later retry cannot alert twice.
  if (filed.inserted && shouldNotifyFamily(result.intent) && channel?.forward_to_phone) {
    try { await sendSms(channel.forward_to_phone, `🚨 Urgent at your Bubaly line: ${result.summary}`); } catch (error) { console.error('[contact-center] urgent SMS escalation failed', error); }
    try {
      await admin.from('notifications').insert({
        family_id: familyId, type: 'system',
        title: '🚨 Urgent message at your family line', body: result.summary,
        related_type: 'contact_center',
      });
    } catch (error) { console.error('[contact-center] urgent notification write failed', error); }
  }

  // A saved inbox row may still need its first successful planner handoff.
  // Re-read its family-scoped completion stamp on replay; intake keeps the
  // original provider-ref idempotency key even if the stamp itself was lost.
  let needsPlanning = filed.inserted;
  if (!filed.messageId) return new NextResponse('Inbox temporarily unavailable', { status: 503 });
  if (!filed.inserted) {
    try {
      const saved = await settle(admin.from('family_inbox_messages').select('ai_handled')
        .eq('id', filed.messageId).eq('family_id', familyId).maybeSingle());
      if (saved.error || !saved.data || typeof saved.data.ai_handled !== 'boolean') throw saved.error ?? new Error('Handled state was unavailable');
      needsPlanning = !saved.data.ai_handled;
    } catch (error) {
      console.error('[contact-center] SMS handled state read failed', error);
      return new NextResponse('Inbox temporarily unavailable', { status: 503 });
    }
  }
  if (needsPlanning) {
    try {
      const outcome = await routeInboundToPlanner(admin, {
        familyId, channel: 'sms', messageId: filed.messageId, body,
        intent: result.intent, providerRef: filed.providerRef,
      });
      if (outcome.reason === 'no_scope' || outcome.reason === 'intake_failed') return new NextResponse('Planner temporarily unavailable', { status: 503 });
    } catch (error) {
      console.error('[contact-center] sms planner routing threw', error);
      return new NextResponse('Planner temporarily unavailable', { status: 503 });
    }
  }

  // Auto-reply unless the concierge is off or it's spam.
  if (channel?.ai_concierge_enabled !== false && result.intent !== 'spam') {
    const reply = result.reply || autoReplyText(result.intent, familyLabel);
    await recordOutboundMessage(admin, { familyId, channel: 'sms', to: from ?? undefined, body: reply });
    return xml(`<Message>${escapeXml(reply)}</Message>`);
  }
  return xml('');
}
