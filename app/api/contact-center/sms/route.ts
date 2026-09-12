// Twilio inbound-SMS webhook for a family's dedicated Contact Center number.
// Files the text into the unified inbox, runs the AI concierge (summary + intent
// + reply), auto-replies via TwiML, and escalates genuine urgencies to the
// family's human fallback number. Signature-validated in production.

import { NextRequest, NextResponse } from 'next/server';
import { getLocaleContext, getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { settle } from '@/lib/supabase/settle';
import { validateTwilioSignature } from '@/lib/guardian/twilio';
import { readBoundedRequestFormData } from '@/lib/server/bounded-request-body';
import { resolveFamilyByNumberResult, getOrCreateChannelResult, routeInboundToPlanner } from '@/lib/contact-center/server';
import { captureInboundWithUrgency, attemptUrgentDelivery } from '@/lib/contact-center/urgent-delivery';
import { runConcierge } from '@/lib/contact-center/concierge';
import { autoReplyText } from '@/lib/contact-center/routing';
import { safeContactText } from '@/lib/contact-center/text';
import { attachSmsReply, prepareSmsReply, reserveSmsReply, type SmsReplyReceipt } from '@/lib/contact-center/sms-reply';

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
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export async function POST(req: NextRequest) {
  const form = await readBoundedRequestFormData(req, MAX_BODY);
  if (!form.ok) return new NextResponse('Invalid callback', { status: form.reason === 'too_large' ? 413 : 400 });
  const params: Record<string, string> = Object.create(null);
  for (const [key, value] of form.value.entries()) {
    if (typeof value !== 'string' || Object.hasOwn(params, key)) return new NextResponse('Invalid callback', { status: 400 });
    params[key] = value;
  }

  if (process.env.NODE_ENV === 'production') {
    const sig = req.headers.get('x-twilio-signature') ?? '';
    if (!validateTwilioSignature(sig, `${BASE_URL}/api/contact-center/sms`, params)) {
      return new NextResponse('Unauthorized', { status: 401 });
    }
  }

  // Advanced Opt-Out has already answered these control messages. Do not
  // send a second concierge reply or turn an opt-out into a planning request.
  if (['STOP', 'START', 'HELP'].includes(params.OptOutType ?? '')) return xml('');
  if (params.MessageSid && params.SmsSid && params.MessageSid !== params.SmsSid) {
    return new NextResponse('Invalid callback', { status: 400 });
  }
  const configuredAccount = process.env.TWILIO_ACCOUNT_SID || undefined;
  if (configuredAccount && !/^AC[0-9a-f]{32}$/i.test(configuredAccount)) {
    return new NextResponse('Contact Center temporarily unavailable', { status: 503 });
  }
  if (params.AccountSid !== undefined && (!/^AC[0-9a-f]{32}$/i.test(params.AccountSid)
    || configuredAccount && params.AccountSid.toLowerCase() !== configuredAccount.toLowerCase())) {
    return new NextResponse('Invalid callback', { status: 400 });
  }
  const accountSid = params.AccountSid ?? configuredAccount;

  const from = params.From ?? null;
  const to = params.To ?? '';
  const body = safeContactText(params.Body ?? '', 4096);
  const sid = params.MessageSid || params.SmsSid || null;

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

  let replyReceipt: SmsReplyReceipt | null = null;
  let result: Pick<Awaited<ReturnType<typeof runConcierge>>, 'summary' | 'intent'>;
  try {
    if (sid && /^(SM|MM)[0-9a-f]{32}$/i.test(sid)) {
      if (!channel || channel.family_id !== familyId || channel.phone_number !== to) {
        return new NextResponse('Contact Center temporarily unavailable', { status: 503 });
      }
      replyReceipt = await prepareSmsReply(admin, { familyId, channelId: channel.family_id, smsSid: sid, from, to, body }, async signal => {
        signal.throwIfAborted();
        const candidate = await runConcierge({ channel: 'sms', from: from ?? undefined, text: body, familyLabel, signal });
        signal.throwIfAborted();
        const { locale } = await getLocaleContext();
        const suppression = channel.ai_concierge_enabled === false ? 'disabled'
          : candidate.intent === 'spam' ? 'spam'
          : !from || !/^\+[1-9]\d{6,14}$/.test(from) ? 'unsupported_recipient' : null;
        const reply = suppression ? null : candidate.intent === 'urgent'
          ? (await getTranslations())('contactUrgent.replySaved')
          : candidate.reply || autoReplyText(candidate.intent, familyLabel);
        signal.throwIfAborted();
        return { summary: candidate.summary, intent: candidate.intent, reply, locale: locale.code, suppression };
      });
      result = replyReceipt.candidate;
    } else {
      // Retain unsupported/legacy intake without inventing a unique reply occasion.
      result = await runConcierge({ channel: 'sms', from: from ?? undefined, text: body, familyLabel });
    }
  } catch {
    return new NextResponse('Reply preparation temporarily unavailable', { status: 503 });
  }

  let filed: Awaited<ReturnType<typeof captureInboundWithUrgency>>;
  try { filed = await captureInboundWithUrgency(admin, {
    familyId, channel: 'sms', from: from ?? undefined, to, body,
    providerRef: replyReceipt?.binding.smsSid ?? sid ?? undefined, aiSummary: result.summary, aiIntent: result.intent,
  }); } catch { return new NextResponse('Inbox temporarily unavailable', { status: 503 }); }
  // Provider failures remain durable and do not skip independent planner recovery.
  const urgentOutcome = filed.urgentReceiptId ? await attemptUrgentDelivery(admin, filed.urgentReceiptId, familyId) : undefined;

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

  if (urgentOutcome === 'failed') return new NextResponse('Urgent delivery state temporarily unavailable', { status: 503 });
  // Only the worker that verifies a new reservation may emit this reply.
  // Replays still finish independent intake and planner recovery above.
  if (replyReceipt) {
    try {
      replyReceipt = await attachSmsReply(admin, replyReceipt, filed.messageId);
      // Validate callback configuration before consuming the single emission.
      let origin: URL | null = null;
      if (replyReceipt.phase === 'queued') {
        origin = new URL(BASE_URL);
        if (origin.origin !== BASE_URL || !['http:', 'https:'].includes(origin.protocol)) throw new Error('Invalid callback origin');
      }
      const reserved = await reserveSmsReply(admin, replyReceipt, { accountSid });
      if (reserved.emission !== null) {
        const callback = new URL('/api/contact-center/sms/status', origin!);
        callback.searchParams.set('receipt', reserved.receipt.id);
        callback.searchParams.set('token', reserved.receipt.emissionToken!);
        const target = escapeXml(callback.toString());
        return xml(`<Message action="${target}" statusCallback="${target}" method="POST">${escapeXml(reserved.emission)}</Message>`);
      }
    } catch {
      return new NextResponse('Reply confirmation temporarily unavailable', { status: 503 });
    }
  }
  return xml('');
}
