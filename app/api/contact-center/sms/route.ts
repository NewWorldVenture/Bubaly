// Twilio inbound-SMS webhook for a family's dedicated Contact Center number.
// Files the text into the unified inbox, runs the AI concierge (summary + intent
// + reply), auto-replies via TwiML, and escalates genuine urgencies to the
// family's human fallback number. Every request requires a valid signature.

import { NextRequest, NextResponse } from 'next/server';
import { getLocaleContext, getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { settle } from '@/lib/supabase/settle';
import { validateTwilioSignature } from '@/lib/guardian/twilio';
import { readBoundedRequestFormData } from '@/lib/server/bounded-request-body';
import { resolveFamilyByNumberResult, getOrCreateChannelResult, routeInboundToPlanner } from '@/lib/contact-center/server';
import { captureInboundWithUrgency, attemptUrgentDelivery } from '@/lib/contact-center/urgent-delivery';
import { runConcierge } from '@/lib/contact-center/concierge';
import { autoReplyText, classifyIntent, summarizeInbound } from '@/lib/contact-center/routing';
import { safeContactText } from '@/lib/contact-center/text';
import { attachSmsReply, prepareSmsReply, reserveSmsReply, type SmsReplyReceipt } from '@/lib/contact-center/sms-reply';
import { captureSmsIngress, readSmsIngress, readLegacySmsReplyForIngress, readLegacyUrgentForIngress, type SmsIngressReceipt } from '@/lib/contact-center/sms-ingress';
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

  try {
    const configuredOrigin = new URL(BASE_URL);
    if (configuredOrigin.origin !== BASE_URL || !['http:', 'https:'].includes(configuredOrigin.protocol)) throw new Error('Invalid callback origin');
  } catch { return new NextResponse('Contact Center temporarily unavailable', { status: 503 }); }
  const sig = req.headers.get('x-twilio-signature') ?? '';
  if (!validateTwilioSignature(sig, `${BASE_URL}/api/contact-center/sms`, params)) {
    return new NextResponse('Unauthorized', { status: 401 });
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
  const originalBody = params.Body ?? '';
  const body = safeContactText(originalBody, 4096);
  const sid = params.MessageSid || params.SmsSid || null;
  const envelope = sid && /^(SM|MM)[0-9a-f]{32}$/i.test(sid)
    ? { smsSid: sid, accountSid: accountSid ?? null, from, to, body: originalBody } : null;

  const admin = createServiceClient();
  let ingress: SmsIngressReceipt | null = null;
  let legacyReply: SmsReplyReceipt | null = null;
  let legacyUrgent: Awaited<ReturnType<typeof readLegacyUrgentForIngress>> = null;
  try {
    if (envelope) {
      ingress = await readSmsIngress(admin, envelope);
      if (!ingress) [legacyReply, legacyUrgent] = await Promise.all([
        readLegacySmsReplyForIngress(admin, envelope), readLegacyUrgentForIngress(admin, envelope),
      ]);
    }
  } catch { return new NextResponse('Intake temporarily unavailable', { status: 503 }); }
  const routed = to ? await resolveFamilyByNumberResult(admin, to) : { familyId: null, error: null };
  if (routed.error) {
    console.error('[contact-center] SMS routing read failed', routed.error);
    return new NextResponse('Routing temporarily unavailable', { status: 503 });
  }
  const familyId = routed.familyId;
  const originalFamilies = [ingress?.binding.familyId, legacyReply?.binding.familyId, legacyUrgent?.family_id];
  if (originalFamilies.some(original => original && familyId !== original)) {
    return new NextResponse('Original destination temporarily unavailable', { status: 503 });
  }
  if (!familyId) return xml(''); // not one of our numbers

  const channelResult = await getOrCreateChannelResult(admin, familyId);
  if (channelResult.error) {
    console.error('[contact-center] SMS family context read failed', channelResult.error);
    return new NextResponse('Contact Center temporarily unavailable', { status: 503 });
  }
  const channel = channelResult.data;
  if (envelope) {
    if (!channel || channel.family_id !== familyId || channel.phone_number !== to) {
      return new NextResponse('Contact Center temporarily unavailable', { status: 503 });
    }
    // Retain the signed original before optional context or candidate work.
    // Older reply receipts already hold their candidate; do not invent an
    // original-body digest for their historically normalized text.
    if (!legacyReply && !legacyUrgent) {
      try { ingress = await captureSmsIngress(admin, { ...envelope, familyId, channelId: channel.family_id }); }
      catch { return new NextResponse('Intake temporarily unavailable', { status: 503 }); }
    }
    if (legacyUrgent && !legacyReply) {
      // Restore historical intake before preparing a reply. Its presence must
      // retain legacy suppression even when the old inbox projection was lost.
      const saved = legacyUrgent.inputs;
      try {
        const restored = await captureInboundWithUrgency(admin, { familyId, channel: 'sms', providerRef: saved.providerRef,
          from: saved.from ?? undefined, to: saved.to ?? undefined, body: saved.body,
          subject: saved.subject ?? undefined, aiSummary: saved.summary, aiIntent: saved.intent });
        if (!restored.messageId) throw new Error('Historical intake unconfirmed');
      } catch { return new NextResponse('Inbox temporarily unavailable', { status: 503 }); }
    }
  }
  const familyResult = await settle(admin.from('families').select('name').eq('id', familyId).maybeSingle());
  if (familyResult.error) {
    console.error('[contact-center] SMS family context read failed', familyResult.error);
    return new NextResponse('Contact Center temporarily unavailable', { status: 503 });
  }
  const familyLabel = familyResult.data?.name || 'the family';
  const boundSid = legacyReply?.binding.smsSid ?? legacyUrgent?.inputs.providerRef ?? ingress?.binding.smsSid ?? sid;

  let replyReceipt: SmsReplyReceipt | null = null;
  let result: Pick<Awaited<ReturnType<typeof runConcierge>>, 'summary' | 'intent'>;
  try {
    if (boundSid && /^(SM|MM)[0-9a-f]{32}$/i.test(boundSid)) {
      if (!channel || channel.family_id !== familyId || channel.phone_number !== to) {
        return new NextResponse('Contact Center temporarily unavailable', { status: 503 });
      }
      replyReceipt = await prepareSmsReply(admin, { familyId, channelId: channel.family_id, smsSid: boundSid, from, to, body }, async signal => {
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
  } catch (error) {
    // Filing the text matters more than answering it. Twilio does not retry an
    // inbound-SMS webhook, so a 503 here is the family never seeing the message
    // at all — and a concierge that overruns the 15s candidate budget, or one
    // slow read inside the reply bookkeeping, was enough to cause one. Fall
    // back to the same deterministic classifier `runConcierge` uses when the
    // model is unavailable: the message is filed, an urgent one still escalates
    // to the human fallback number, and the only thing lost is the auto-reply.
    console.error('[contact-center] SMS reply preparation failed; filing without a reply', error);
    replyReceipt = null;
    result = { summary: summarizeInbound(body), intent: classifyIntent(body) };
  }

  // main reached the family here with an inline sendSms plus a notifications
  // insert whose error it had just been taught to read. Neither is re-added:
  // attemptUrgentDelivery below is the same escalation with receipts, and
  // ensureNotification does strictly more than that fix asked for — it THROWS on
  // the insert error, reads the row back and checks its identity, and leaves
  // notificationDone false if any of that fails, which returns 'failed' and makes
  // this route answer 503 so Twilio retries. A logged line became a retry.
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
