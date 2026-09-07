// app/api/guardian/status/voicemail/route.ts
// Twilio callback after a voicemail recording completes.
// Updates the communication record and notifies the family.

import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { notify } from '@/lib/services/notifications';
import { systemScopeForFamily } from '@/lib/services/scope';
import { withGuardianTables } from '@/lib/supabase/guardian-tables';
import { wrapTwiml, twimlSay, twimlHangup, validateTwilioSignature } from '@/lib/guardian/twilio';
import { formatPhone } from '@/lib/guardian/phone';
import { claimGuardianCallback, isValidGuardianEventId, markGuardianCallbackProcessed } from '@/lib/guardian/callbacks';
import { readBoundedRequestFormData } from '@/lib/server/bounded-request-body';

export const runtime = 'nodejs';

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? '';
const MAX_TWILIO_BODY_BYTES = 64 * 1024;

export async function POST(req: NextRequest) {
  const tr = await getTranslations();
  const { searchParams } = new URL(req.url);
  const commId = searchParams.get('commId') ?? '';

  const boundedForm = await readBoundedRequestFormData(req, MAX_TWILIO_BODY_BYTES);
  if (!boundedForm.ok) return new NextResponse(boundedForm.reason === 'too_large' ? 'Payload too large' : 'Invalid callback', { status: boundedForm.reason === 'too_large' ? 413 : 400 });
  const params = Object.fromEntries(boundedForm.value.entries()) as Record<string, string>;

  // Validate Twilio signature (skip in dev) — same guard as the inbound routes.
  if (process.env.NODE_ENV === 'production') {
    const sig = req.headers.get('x-twilio-signature') ?? '';
    const url = `${BASE_URL}${req.nextUrl.pathname}${req.nextUrl.search}`;
    if (!validateTwilioSignature(sig, url, params)) {
      return new NextResponse('Unauthorized', { status: 401 });
    }
  }

  const recordingUrl = params.RecordingUrl ?? null;
  const recordingDuration = params.RecordingDuration ? parseInt(params.RecordingDuration, 10) : null;
  const transcriptionText = params.TranscriptionText ?? null;
  const recordingSid = params.RecordingSid ?? '';

  if ((commId && !isValidGuardianEventId(commId)) || !isValidGuardianEventId(recordingSid)
    || (recordingDuration !== null && (!Number.isInteger(recordingDuration) || recordingDuration < 0 || recordingDuration > 120))
    || (recordingUrl !== null && recordingUrl.length > 2048)
    || (transcriptionText !== null && transcriptionText.length > 4096)) {
    return new NextResponse('Invalid callback', { status: 400 });
  }

  if (!commId) {
    return new NextResponse(wrapTwiml(twimlSay(tr('voicemail.thankYouGoodbye')), twimlHangup()), {
      headers: { 'content-type': 'application/xml' },
    });
  }

  const supabase = createServiceClient();
  const eventClaimed = await claimGuardianCallback(supabase, 'voicemail_recording', recordingSid);
  if (!eventClaimed) {
    return new NextResponse(wrapTwiml(twimlSay(tr('voicemail.thankYouGoodbye')), twimlHangup()), {
      headers: { 'content-type': 'application/xml' },
    });
  }
  const db = withGuardianTables(supabase);
  const gFrom = (t: Parameters<typeof db.from>[0]) => (db.from(t) as ReturnType<typeof supabase.from>);

  // Fetch communication to get family context
  const { data: comm } = await gFrom('guardian_communications')
    .select('family_id, member_id, from_number, from_name')
    .eq('id', commId)
    .maybeSingle();

  if (comm) {
    const typedComm = comm as {
      family_id: string;
      member_id: string | null;
      from_number: string | null;
      from_name: string | null;
    };

    // Update the communication record with recording
    await gFrom('guardian_communications').update({
      status: 'handled',
      call_recording_url: recordingUrl,
      call_duration_secs: recordingDuration,
      body: transcriptionText,
      summary: transcriptionText
        ? `Voicemail from ${typedComm.from_name ?? formatPhone(typedComm.from_number)}: "${transcriptionText.slice(0, 120)}"`
        : `Voicemail received from ${typedComm.from_name ?? formatPhone(typedComm.from_number)}`,
      ended_at: new Date().toISOString(),
    }).eq('id', commId);

    // Notify family
    const callerDisplay = typedComm.from_name ?? formatPhone(typedComm.from_number);
    const bodyText = transcriptionText
      ? `"${transcriptionText.slice(0, 100)}${transcriptionText.length > 100 ? '…' : ''}"`
      : 'Tap to listen to the voicemail.';

    // A voicemail is a message waiting, not an emergency: it obeys quiet
    // hours like the text and WhatsApp routes. The caller has already hung up,
    // so nothing is lost by telling the family when they are awake.
    const scope = await systemScopeForFamily(supabase, typedComm.family_id);
    if (scope) {
      await notify(scope, {
        recipients: 'family',
        type: 'system',
        title: `📩 Voicemail from ${callerDisplay}`,
        body: bodyText,
        relatedType: 'guardian_communications',
        relatedId: commId,
      });
    }
  }

  await markGuardianCallbackProcessed(supabase, recordingSid);
  return new NextResponse(
    wrapTwiml(twimlSay(tr('voicemail.thankYouForYourMessage')), twimlHangup()),
    { headers: { 'content-type': 'application/xml' } },
  );
}
