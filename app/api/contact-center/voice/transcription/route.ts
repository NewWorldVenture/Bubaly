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
  if (!familyId) return new NextResponse(null, { status: 204 });

  const text = (params.TranscriptionText ?? '').slice(0, 4096);
  const from = params.From ?? null;
  const sid = params.RecordingSid ?? params.TranscriptionSid ?? null;
  if (!text.trim()) return new NextResponse(null, { status: 204 });

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

  // Keep urgent escalation independent of planner availability. A retry keeps
  // recovering the handoff below without repeating the original alert.
  if (filed.inserted && shouldNotifyFamily(result.intent) && channel?.forward_to_phone) {
    try { await sendSms(channel.forward_to_phone, `🚨 Urgent voicemail at your Bubaly line: ${result.summary}`); } catch (error) { console.error('[contact-center] urgent voicemail SMS failed', error); }
    try {
      await admin.from('notifications').insert({
        family_id: familyId, type: 'system',
        title: '🚨 Urgent voicemail at your family line', body: result.summary,
        related_type: 'contact_center',
      });
    } catch (error) { console.error('[contact-center] urgent voicemail notification write failed', error); }
  }

  // Capture and planning can fail independently. Resume an unhandled saved
  // voicemail on replay, retaining the provider-ref intake idempotency key.
  let needsPlanning = filed.inserted;
  if (!filed.messageId) return new NextResponse('Inbox temporarily unavailable', { status: 503 });
  if (!filed.inserted) {
    try {
      const saved = await settle(admin.from('family_inbox_messages').select('ai_handled')
        .eq('id', filed.messageId).eq('family_id', familyId).maybeSingle());
      if (saved.error || !saved.data || typeof saved.data.ai_handled !== 'boolean') throw saved.error ?? new Error('Handled state was unavailable');
      needsPlanning = !saved.data.ai_handled;
    } catch (error) {
      console.error('[contact-center] voicemail handled state read failed', error);
      return new NextResponse('Inbox temporarily unavailable', { status: 503 });
    }
  }
  if (needsPlanning) {
    try {
      const outcome = await routeInboundToPlanner(admin, {
        familyId, channel: 'voice', messageId: filed.messageId, body: text,
        intent: result.intent, providerRef: filed.providerRef,
      });
      if (outcome.reason === 'no_scope' || outcome.reason === 'intake_failed') return new NextResponse('Planner temporarily unavailable', { status: 503 });
    } catch (error) {
      console.error('[contact-center] voicemail planner routing threw', error);
      return new NextResponse('Planner temporarily unavailable', { status: 503 });
    }
  }

  return new NextResponse(null, { status: 204 });
}
