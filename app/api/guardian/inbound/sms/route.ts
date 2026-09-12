// Signed Twilio ingress. Recovery uses the same processor from trusted receipts.
import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { validateTwilioSignature } from '@/lib/guardian/twilio';
import { receiveGuardianSms } from '@/lib/guardian/sms-processing';
import { readBoundedRequestFormData } from '@/lib/server/bounded-request-body';

export const runtime = 'nodejs';
const BASE_URL = (process.env.NEXT_PUBLIC_APP_URL ?? '').trim().replace(/\/+$/, '');
const MAX_TWILIO_BODY_BYTES = 64 * 1024;

export async function POST(req: NextRequest) {
  const boundedForm = await readBoundedRequestFormData(req, MAX_TWILIO_BODY_BYTES);
  if (!boundedForm.ok) return new NextResponse(boundedForm.reason === 'too_large' ? 'Payload too large' : 'Invalid callback', { status: boundedForm.reason === 'too_large' ? 413 : 400 });
  const seen = new Set<string>();
  for (const [key, value] of boundedForm.value.entries()) {
    if (typeof value !== 'string' || seen.has(key)) return new NextResponse('Invalid callback', { status: 400 });
    seen.add(key);
  }
  const params = Object.fromEntries(boundedForm.value.entries()) as Record<string, string>;

  if (process.env.NODE_ENV === 'production') {
    const sig = req.headers.get('x-twilio-signature') ?? '';
    const url = `${BASE_URL}/api/guardian/inbound/sms`;
    if (!validateTwilioSignature(sig, url, params)) {
      return new NextResponse('Unauthorized', { status: 401 });
    }
  }

  const from = params.From ?? null;
  const to = params.To ?? null;
  const body = params.Body ?? '';
  const smsSid = params.SmsSid ?? params.MessageSid ?? null;

  if (!smsSid || !/^(SM|MM)[0-9a-f]{32}$/i.test(smsSid) || (params.SmsSid && params.MessageSid && params.SmsSid !== params.MessageSid)
    || !to || !/^\+[1-9]\d{7,14}$/.test(to) || (from !== null && (!from || from.length > 64 || /[\x00-\x1f\x7f]/.test(from))) || body.length > 4096) {
    return new NextResponse('Invalid callback', { status: 400 });
  }

  let supabase: ReturnType<typeof createServiceClient>;
  try { supabase = createServiceClient(); } catch { return new NextResponse('Intake unavailable', { status: 503 }); }
  const result = await receiveGuardianSms(supabase, { smsSid, from, to, body }, { signal: req.signal });
  return new NextResponse(result === 'completed' ? '' : 'Intake unavailable', {
    status: result === 'completed' ? 200 : result === 'invalid' ? 400 : 503,
  });
}
