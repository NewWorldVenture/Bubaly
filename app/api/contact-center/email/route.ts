// Inbound-email webhook for a family's @bubaly.com address. An inbound-email
// provider (SendGrid Inbound Parse, Cloudflare Email Routing → webhook, Mailgun,
// etc.) POSTs each message here; we resolve the family by the recipient
// local-part, file it into the unified inbox, run the AI concierge, and (best
// effort) send a courteous auto-reply. Accepts multipart/form-data OR JSON.
//
// Auth: fail-closed. Requires CONTACT_CENTER_INBOUND_SECRET (as ?key= or the
// x-inbound-secret header). Without the secret set, rejects in production so the
// endpoint is never an open relay; permitted in dev for local testing.

import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { settle } from '@/lib/supabase/settle';
import { readBoundedRequestFormData, readBoundedRequestText } from '@/lib/server/bounded-request-body';
import { sendEmail } from '@/lib/server/email';
import { parseRecipientLocal, buildBubalyAddress } from '@/lib/contact-center/address';
import {
  resolveFamilyByEmailLocalResult, getOrCreateChannelResult, recordOutboundMessage,
  routeInboundToPlanner, fileInboundPaperwork,
} from '@/lib/contact-center/server';
import { runConcierge } from '@/lib/contact-center/concierge';
import { captureInboundWithUrgency, attemptUrgentDelivery } from '@/lib/contact-center/urgent-delivery';
import { fileEmailAttachments, MAX_MULTIPART_EMAIL_BYTES } from '@/lib/services/paperwork/email-attachments';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY = 1024 * 1024; // inbound emails can carry a lot of text

function authorized(req: NextRequest): boolean {
  const secret = process.env.CONTACT_CENTER_INBOUND_SECRET;
  if (!secret) return process.env.NODE_ENV !== 'production';
  const provided = new URL(req.url).searchParams.get('key') ?? req.headers.get('x-inbound-secret');
  return !!provided && provided === secret;
}

// Pull the fields we need from either a parsed form or a JSON body.
function pick(src: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = src[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return '';
}

export async function POST(req: NextRequest) {
  if (!authorized(req)) return new NextResponse('Unauthorized', { status: 401 });

  const ctype = req.headers.get('content-type') ?? '';
  let fields: Record<string, unknown> = {};
  const attachments: File[] = [];
  try {
    if (ctype.includes('application/json')) {
      const raw = await readBoundedRequestText(req, MAX_BODY);
      if (!raw.ok) return new NextResponse('Payload too large', { status: 413 });
      const parsed: unknown = JSON.parse(raw.text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return new NextResponse('Invalid payload', { status: 400 });
      fields = parsed as Record<string, unknown>;
    } else {
      const form = await readBoundedRequestFormData(req, MAX_MULTIPART_EMAIL_BYTES);
      if (!form.ok) return new NextResponse('Payload too large', { status: 413 });
      for (const [key, value] of form.value.entries()) {
        if (typeof value === 'string') fields[key] = value;
        else attachments.push(value);
      }
    }
  } catch {
    return new NextResponse('Invalid payload', { status: 400 });
  }

  const to = pick(fields, 'to', 'To', 'recipient', 'envelope_to');
  const from = pick(fields, 'from', 'From', 'sender') || null;
  const subject = pick(fields, 'subject', 'Subject') || null;
  const body = (pick(fields, 'text', 'body-plain', 'stripped-text', 'plain') || pick(fields, 'html', 'body-html')).slice(0, 8000);
  const messageId = pick(fields, 'Message-Id', 'message-id', 'messageId') || null;

  const local = parseRecipientLocal(to);
  if (!local) return NextResponse.json({ ok: true, skipped: 'no bubaly recipient' });

  const admin = createServiceClient();
  const routed = await resolveFamilyByEmailLocalResult(admin, local);
  if (routed.error) {
    console.error('[contact-center] email routing read failed', routed.error);
    return new NextResponse('Routing temporarily unavailable', { status: 503 });
  }
  const familyId = routed.familyId;
  if (!familyId) return NextResponse.json({ ok: true, skipped: 'unknown address' });

  const [channelResult, familyResult] = await Promise.all([
    getOrCreateChannelResult(admin, familyId),
    settle(admin.from('families').select('name').eq('id', familyId).maybeSingle()),
  ]);
  if (channelResult.error || familyResult.error) {
    console.error('[contact-center] email family context read failed', channelResult.error ?? familyResult.error);
    return new NextResponse('Contact Center temporarily unavailable', { status: 503 });
  }
  const channel = channelResult.data;
  const familyLabel = familyResult.data?.name || 'the family';

  const result = await runConcierge({ channel: 'email', from: from ?? undefined, text: body || subject || '', familyLabel });
  let filed: Awaited<ReturnType<typeof captureInboundWithUrgency>>;
  try { filed = await captureInboundWithUrgency(admin, {
    familyId, channel: 'email', from: from ?? undefined, to, subject: subject ?? undefined,
    body: body || subject || '(no content)', providerRef: messageId ?? undefined,
    aiSummary: result.summary, aiIntent: result.intent,
  }); } catch { return new NextResponse('Inbox temporarily unavailable', { status: 503 }); }
  const urgentOutcome = filed.urgentReceiptId ? await attemptUrgentDelivery(admin, filed.urgentReceiptId, familyId) : undefined;

  // A saved inbox delivery can still need paperwork enrichment. Retry the
  // same captured row before acknowledging it, including on redelivery.
  try {
    const paperworkText = [subject?.trim(), body.trim()].filter(Boolean).join('\n\n').slice(0, 4_000);
    if (paperworkText) await fileInboundPaperwork(admin, familyId, paperworkText, undefined, filed.providerRef, from);
  } catch (error) {
    console.error('[contact-center] email paperwork needs retry', error);
    return new NextResponse('Paperwork temporarily unavailable', { status: 503 });
  }

  // Capture may have succeeded before an earlier enrichment failure. Such a
  // retry still needs its first planner handoff; persisted requests retain the
  // existing provider-ref idempotency key so a completed handoff never repeats.
  let needsPlanning = filed.inserted;
  if (!filed.inserted && filed.messageId) {
    try {
      const saved = await settle(admin.from('family_inbox_messages').select('ai_handled')
        .eq('id', filed.messageId).eq('family_id', familyId).maybeSingle());
      if (saved.error || !saved.data || typeof saved.data.ai_handled !== 'boolean') throw saved.error ?? new Error('Handled state was unavailable');
      needsPlanning = !saved.data.ai_handled;
    } catch (error) {
      console.error('[contact-center] email handled state read failed', error);
      return new NextResponse('Inbox temporarily unavailable', { status: 503 });
    }
  }

  // M20: an appointment, a delivery or a personal note becomes work in the
  // planner (trust-gated, approval spine unchanged), and an emailed bill or
  // reservation becomes a paperwork row. Already handled messages skip the
  // planner while interrupted captures can finish their original handoff.
  if (needsPlanning) {
    try {
      const outcome = await routeInboundToPlanner(admin, {
        familyId, channel: 'email', messageId: filed.messageId,
        subject: subject ?? null, body: body || subject || '',
        intent: result.intent, providerRef: filed.providerRef, sender: from,
      });
      if (outcome.reason === 'no_scope' || outcome.reason === 'intake_failed') return new NextResponse('Planner temporarily unavailable', { status: 503 });
    } catch (error) {
      console.error('[contact-center] email planner routing threw', error);
      return new NextResponse('Planner temporarily unavailable', { status: 503 });
    }
  }

  // Every delivery retries attachments independently, including a duplicate
  // inbox message. Previously saved documents survive later failures and are
  // re-read by deterministic id, without repeating OCR or overwriting edits.
  const attachmentResult = await fileEmailAttachments(admin, {
    familyId, inboxMessageId: filed.messageId, providerRef: filed.providerRef,
    sender: from, subject, files: attachments,
  });
  if (!attachmentResult.ok) {
    return NextResponse.json({ ok: false, retryable: true, attachments: attachmentResult.results }, {
      status: 503, headers: { 'Retry-After': '30' },
    });
  }

  if (urgentOutcome === 'failed') return new NextResponse('Urgent delivery state temporarily unavailable', { status: 503 });
  // Auto-reply acknowledges intake; it does not assert that the fallback text arrived.
  if (channel?.ai_concierge_enabled !== false && result.intent !== 'spam' && from) {
    try {
      const reply = filed.escalated ? (await getTranslations())('contactUrgent.replySaved') : result.reply;
      await sendEmail({
        to: from,
        subject: subject ? `Re: ${subject}` : `Message received — ${familyLabel}`,
        html: `<p>${reply.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p><p style="color:#888;font-size:12px">— ${familyLabel} via ${buildBubalyAddress(local)}</p>`,
      });
      await recordOutboundMessage(admin, { familyId, channel: 'email', to: from, body: reply });
    } catch (error) { console.error('[contact-center] email auto-reply failed', error); }
  }

  return NextResponse.json({ ok: true, intent: result.intent, attachments: attachmentResult.results });
}
