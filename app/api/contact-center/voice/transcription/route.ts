// Twilio transcribeCallback for a Contact Center voicemail. Files the transcript
// into the unified inbox, runs the AI concierge (summary + intent), and escalates
// genuine urgencies to the family's human fallback. Fires asynchronously after
// the call ends, so it returns 204 with no TwiML.

import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { settle } from '@/lib/supabase/settle';
import { validateTwilioSignature, sendSms } from '@/lib/guardian/twilio';
import { readBoundedRequestFormData } from '@/lib/server/bounded-request-body';
import { getOrCreateChannelResult, recordInboundMessage, routeInboundToPlanner } from '@/lib/contact-center/server';
import { runConcierge } from '@/lib/contact-center/concierge';
import { shouldNotifyFamily } from '@/lib/contact-center/routing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BASE_URL = (process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/$/, '');
const MAX_BODY = 64 * 1024;

export async function POST(req: NextRequest) {
  const form = await readBoundedRequestFormData(req, MAX_BODY);
  if (!form.ok) return new NextResponse('Invalid callback', { status: form.reason === 'too_large' ? 413 : 400 });
  const params = Object.fromEntries(form.value.entries()) as Record<string, string>;

  const familyId = new URL(req.url).searchParams.get('familyId') ?? '';
  if (process.env.NODE_ENV === 'production') {
    const sig = req.headers.get('x-twilio-signature') ?? '';
    const url = `${BASE_URL}/api/contact-center/voice/transcription?familyId=${familyId}`;
    if (!validateTwilioSignature(sig, url, params)) return new NextResponse('Unauthorized', { status: 401 });
  }
  if (!familyId) return new NextResponse('', { status: 204 });

  const text = (params.TranscriptionText ?? '').slice(0, 4096);
  const from = params.From ?? null;
  const sid = params.RecordingSid ?? params.TranscriptionSid ?? null;
  if (!text.trim()) return new NextResponse('', { status: 204 });

  const admin = createServiceClient();
  const [channelResult, familyResult] = await Promise.all([
    getOrCreateChannelResult(admin, familyId),
    settle(admin.from('families').select('name').eq('id', familyId).maybeSingle()),
  ]);
  if (channelResult.error || familyResult.error) {
    console.error('[contact-center] transcription family context read failed', channelResult.error ?? familyResult.error);
    return new NextResponse('Contact Center temporarily unavailable', { status: 503 });
  }
  const channel = channelResult.data;
  const familyLabel = familyResult.data?.name || 'the family';

  const result = await runConcierge({ channel: 'voice', from: from ?? undefined, text, familyLabel });
  const filed = await recordInboundMessage(admin, {
    familyId, channel: 'voice', from: from ?? undefined, subject: 'Voicemail', body: text,
    providerRef: sid ?? undefined, aiSummary: result.summary, aiIntent: result.intent,
  });

  // M20: a voicemail asking to reschedule is work, not an audio file. Twilio
  // retries a transcription callback, so only a delivery that was actually new
  // reaches the planner.
  if (filed.inserted) {
    await routeInboundToPlanner(admin, {
      familyId, channel: 'voice', messageId: filed.messageId, body: text,
      intent: result.intent, providerRef: filed.providerRef,
    }).catch((error) => { console.error('[contact-center] voicemail planner routing threw', error); });
  }

  if (shouldNotifyFamily(result.intent) && channel?.forward_to_phone) {
    try { await sendSms(channel.forward_to_phone, `🚨 Urgent voicemail at your Bubaly line: ${result.summary}`); } catch (error) { console.error('[contact-center] urgent voicemail SMS failed', error); }
    try {
      await admin.from('notifications').insert({
        family_id: familyId, type: 'system',
        title: '🚨 Urgent voicemail at your family line', body: result.summary,
        related_type: 'contact_center',
      });
    } catch (error) { console.error('[contact-center] urgent voicemail notification write failed', error); }
  }

  return new NextResponse('', { status: 204 });
}
