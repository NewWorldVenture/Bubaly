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
import { appBaseUrl } from '@/lib/server/app-url';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BASE_URL = appBaseUrl();
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

  // M20: actionable texts reach the planner instead of stopping at the log —
  // and only when this delivery was new, so a re-fired webhook is not a second
  // run and a second row.
  if (filed.inserted) {
    await routeInboundToPlanner(admin, {
      familyId, channel: 'sms', messageId: filed.messageId, body,
      intent: result.intent, providerRef: filed.providerRef,
    }).catch((error) => { console.error('[contact-center] sms planner routing threw', error); });
  }

  // Escalate genuine urgencies to the family's human fallback — and only on a
  // delivery that was actually NEW. `filed.inserted` is the same signal the
  // planner routing above turns on, for the same reason: Twilio can re-fire this
  // webhook, and without it a redelivery sends the family a SECOND 🚨 text and
  // files a second urgent notification about one message. The sibling email
  // route already reads `filed.inserted && shouldNotifyFamily(…)`; these two
  // stated the reasoning and then did not apply it to the side effects that
  // actually reach a person.
  if (filed.inserted && shouldNotifyFamily(result.intent) && channel?.forward_to_phone) {
    try { await sendSms(channel.forward_to_phone, `🚨 Urgent at your Bubaly line: ${result.summary}`); } catch (error) { console.error('[contact-center] urgent SMS escalation failed', error); }
    try {
      const { error: notifyError } = await admin.from('notifications').insert({
        family_id: familyId, type: 'system',
        title: '🚨 Urgent message at your family line', body: result.summary,
        related_type: 'contact_center',
      });
      // The insert resolves with an error rather than throwing, so this catch
      // never saw a failed write: an urgent message reached nobody, silently.
      if (notifyError) console.error('[contact-center] urgent notification write failed', notifyError);
    } catch (error) { console.error('[contact-center] urgent notification write threw', error); }
  }

  // Auto-reply unless the concierge is off or it's spam.
  if (channel?.ai_concierge_enabled !== false && result.intent !== 'spam') {
    const reply = result.reply || autoReplyText(result.intent, familyLabel);
    await recordOutboundMessage(admin, { familyId, channel: 'sms', to: from ?? undefined, body: reply });
    return xml(`<Message>${escapeXml(reply)}</Message>`);
  }
  return xml('');
}
