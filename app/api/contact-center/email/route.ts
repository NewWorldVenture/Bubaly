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
import { createServiceClient } from '@/lib/supabase/server';
import { settle } from '@/lib/supabase/settle';
import { readBoundedRequestFormData, readBoundedRequestText } from '@/lib/server/bounded-request-body';
import { sendEmail } from '@/lib/server/email';
import { sendSms } from '@/lib/guardian/twilio';
import { parseRecipientLocal, buildBubalyAddress } from '@/lib/contact-center/address';
import {
  resolveFamilyByEmailLocalResult, getOrCreateChannelResult, recordInboundMessage, recordOutboundMessage,
  routeInboundToPlanner,
} from '@/lib/contact-center/server';
import { runConcierge } from '@/lib/contact-center/concierge';
import { shouldNotifyFamily } from '@/lib/contact-center/routing';

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
  try {
    if (ctype.includes('application/json')) {
      const raw = await readBoundedRequestText(req, MAX_BODY);
      if (!raw.ok) return new NextResponse('Payload too large', { status: 413 });
      fields = JSON.parse(raw.text) as Record<string, unknown>;
    } else {
      const form = await readBoundedRequestFormData(req, MAX_BODY);
      if (!form.ok) return new NextResponse('Payload too large', { status: 413 });
      fields = Object.fromEntries([...form.value.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : '']));
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
  const filed = await recordInboundMessage(admin, {
    familyId, channel: 'email', from: from ?? undefined, to, subject: subject ?? undefined,
    body: body || subject || '(no content)', providerRef: messageId ?? undefined,
    aiSummary: result.summary, aiIntent: result.intent,
  });

  // M20: an appointment, a delivery or a personal note becomes work in the
  // planner (trust-gated, approval spine unchanged), and an emailed bill or
  // reservation becomes a paperwork row. Never fatal — the provider gets its
  // acknowledgement regardless.
  //
  // ONLY ON A NEW DELIVERY. Providers re-fire webhooks; routing a message the
  // inbox already holds would file the same bill a second time and double the
  // household queue's "needs you" count.
  if (filed.inserted) {
    await routeInboundToPlanner(admin, {
      familyId, channel: 'email', messageId: filed.messageId,
      subject: subject ?? null, body: body || subject || '',
      intent: result.intent, providerRef: filed.providerRef,
    }).catch((error) => { console.error('[contact-center] email planner routing threw', error); });
  }

  // Urgent → ping the human fallback by SMS.
  if (shouldNotifyFamily(result.intent) && channel?.forward_to_phone) {
    try { await sendSms(channel.forward_to_phone, `🚨 Urgent email at your Bubaly line: ${result.summary}`); } catch (error) { console.error('[contact-center] urgent email SMS failed', error); }
  }

  // Auto-reply (best-effort) unless the concierge is off or it's spam.
  if (channel?.ai_concierge_enabled !== false && result.intent !== 'spam' && from) {
    try {
      await sendEmail({
        to: from,
        subject: subject ? `Re: ${subject}` : `Message received — ${familyLabel}`,
        html: `<p>${result.reply.replace(/</g, '&lt;')}</p><p style="color:#888;font-size:12px">— ${familyLabel} via ${buildBubalyAddress(local)}</p>`,
      });
      await recordOutboundMessage(admin, { familyId, channel: 'email', to: from, body: result.reply });
    } catch (error) { console.error('[contact-center] email auto-reply failed', error); }
  }

  return NextResponse.json({ ok: true, intent: result.intent });
}
