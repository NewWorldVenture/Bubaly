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
import { readBoundedRequestText } from '@/lib/server/bounded-request-body';
import { sendEmail } from '@/lib/server/email';
import { sendSms } from '@/lib/guardian/twilio';
import { parseRecipientLocal, buildBubalyAddress } from '@/lib/contact-center/address';
import {
  resolveFamilyByEmailLocal, getOrCreateChannel, recordInboundMessage, recordOutboundMessage,
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
      const form = await req.formData();
      fields = Object.fromEntries([...form.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : '']));
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
  const familyId = await resolveFamilyByEmailLocal(admin, local);
  if (!familyId) return NextResponse.json({ ok: true, skipped: 'unknown address' });

  const [channel, { data: fam }] = await Promise.all([
    getOrCreateChannel(admin, familyId),
    admin.from('families').select('name').eq('id', familyId).maybeSingle(),
  ]);
  const familyLabel = fam?.name || 'the family';

  const result = await runConcierge({ channel: 'email', from: from ?? undefined, text: body || subject || '', familyLabel });
  await recordInboundMessage(admin, {
    familyId, channel: 'email', from: from ?? undefined, to, subject: subject ?? undefined,
    body: body || subject || '(no content)', providerRef: messageId ?? undefined,
    aiSummary: result.summary, aiIntent: result.intent,
  });

  // Urgent → ping the human fallback by SMS.
  if (shouldNotifyFamily(result.intent) && channel?.forward_to_phone) {
    try { await sendSms(channel.forward_to_phone, `🚨 Urgent email at your Bubaly line: ${result.summary}`); } catch { /* best-effort */ }
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
    } catch { /* best-effort */ }
  }

  return NextResponse.json({ ok: true, intent: result.intent });
}
