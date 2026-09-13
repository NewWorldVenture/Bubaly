import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { validateTwilioSignature } from '@/lib/guardian/twilio';
import { readBoundedRequestFormData } from '@/lib/server/bounded-request-body';
import { recordSmsReplyDelivery, SmsReplyInvalidDeliveryError } from '@/lib/contact-center/sms-reply';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PATH = '/api/contact-center/sms/status';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SID = /^(SM|MM)[0-9a-f]{32}$/i;
const ACCOUNT = /^AC[0-9a-f]{32}$/i;
const PHONE = /^\+[1-9]\d{7,14}$/;
const STATUSES = ['queued', 'sending', 'sent', 'delivered', 'undelivered', 'failed'] as const;
const invalid = () => new NextResponse('Invalid callback', { status: 400 });
const unavailable = () => new NextResponse('Status temporarily unavailable', { status: 503 });

export async function POST(req: NextRequest) {
  const url = new URL(req.url);
  if (url.pathname !== PATH || url.hash || [...url.searchParams].length !== 2
    || url.searchParams.getAll('receipt').length !== 1 || url.searchParams.getAll('token').length !== 1) return invalid();
  const receiptId = url.searchParams.get('receipt')!, emissionToken = url.searchParams.get('token')!;
  if (!UUID.test(receiptId) || !UUID.test(emissionToken)) return invalid();

  const form = await readBoundedRequestFormData(req, 64 * 1024);
  if (!form.ok) return new NextResponse('Invalid callback', { status: form.reason === 'too_large' ? 413 : 400 });
  const params: Record<string, string> = Object.create(null);
  for (const [key, value] of form.value.entries()) {
    if (typeof value !== 'string' || Object.hasOwn(params, key)) return invalid();
    params[key] = value;
  }

  let origin: string;
  try {
    const base = (process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/$/, '');
    const configured = new URL(base);
    if (!['https:', 'http:'].includes(configured.protocol) || configured.username || configured.password
      || configured.origin !== base) return unavailable();
    origin = configured.origin;
  } catch { return unavailable(); }
  // The trusted origin is configured; query encoding/order and every form field
  // remain part of Twilio's signature, including future provider parameters.
  const query = req.url.slice(req.url.indexOf('?'));
  if (!validateTwilioSignature(req.headers.get('x-twilio-signature') ?? '', `${origin}${PATH}${query}`, params)) {
    return new NextResponse('Unauthorized', { status: 403 });
  }
  if (params.MessageSid !== undefined && params.SmsSid !== undefined && params.MessageSid !== params.SmsSid
    || params.MessageStatus !== undefined && params.SmsStatus !== undefined && params.MessageStatus !== params.SmsStatus) return invalid();
  const providerSid = params.MessageSid ?? params.SmsSid, status = params.MessageStatus ?? params.SmsStatus;
  if (!providerSid || !SID.test(providerSid) || !STATUSES.includes(status as typeof STATUSES[number])) return invalid();
  if (params.From !== undefined && !PHONE.test(params.From) || params.To !== undefined && !PHONE.test(params.To)
    || params.AccountSid !== undefined && !ACCOUNT.test(params.AccountSid)) return invalid();
  if (params.AccountSid !== undefined) {
    const account = process.env.TWILIO_ACCOUNT_SID ?? '';
    if (account && !ACCOUNT.test(account)) return unavailable();
    if (account && params.AccountSid.toLowerCase() !== account.toLowerCase()) return new NextResponse('Unauthorized', { status: 403 });
  }
  try {
    await recordSmsReplyDelivery(createServiceClient(), {
      receiptId, emissionToken, providerSid, status: status as typeof STATUSES[number],
      ...(params.From === undefined ? {} : { from: params.From }),
      ...(params.To === undefined ? {} : { to: params.To }),
      ...(params.AccountSid === undefined ? {} : { accountSid: params.AccountSid }),
    }, { signal: req.signal });
  } catch (error) {
    return error instanceof SmsReplyInvalidDeliveryError ? new NextResponse('Unauthorized', { status: 403 }) : unavailable();
  }
  // A status event must never produce another message or re-run the concierge.
  return new NextResponse('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', {
    status: 200, headers: { 'content-type': 'text/xml; charset=utf-8' },
  });
}
