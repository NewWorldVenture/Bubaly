// app/api/guardian/status/voicemail/route.ts
// Twilio callback after a voicemail recording completes.
// Updates the communication record and notifies the family.

import { NextRequest, NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { withGuardianTables, type GuardianTables } from '@/lib/supabase/guardian-tables';
import { wrapTwiml, twimlSay, twimlHangup, validateTwilioSignature } from '@/lib/guardian/twilio';
import { formatPhone } from '@/lib/guardian/phone';
import { isValidGuardianEventId } from '@/lib/guardian/callbacks';
import { claimGuardianVoicemail, finishGuardianVoicemail, guardianVoicemailReceiptId, releaseGuardianVoicemail, requireGuardianVoicemailLease } from '@/lib/guardian/voicemail-intake';
import { guardianSmsScope, notifyGuardianSms } from '@/lib/guardian/sms-notification';
import { smsStep } from '@/lib/guardian/sms-deadline';
import { readBoundedRequestFormData } from '@/lib/server/bounded-request-body';

export const runtime = 'nodejs';

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? '';
const MAX_TWILIO_BODY_BYTES = 64 * 1024;
// The legacy Guardian adapter erases query results to an overloaded from()
// return type. Keep this route's actual table schema through bounded queries.
type VoicemailDatabase = Database & { public: { Tables: { guardian_communications: {
  Row: GuardianTables['guardian_communications'];
  Insert: Partial<GuardianTables['guardian_communications']>;
  Update: Partial<GuardianTables['guardian_communications']>;
  Relationships: [];
} } } };

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

  let supabase: ReturnType<typeof createServiceClient>;
  try { supabase = createServiceClient(); } catch { return new NextResponse('', { status: 503 }); }
  const signal = AbortSignal.any([req.signal, AbortSignal.timeout(5000)]);
  const claim = await claimGuardianVoicemail(supabase, recordingSid, commId, signal);
  // Only a verified completion can acknowledge a duplicate. A current worker
  // or an unavailable required operation leaves the provider able to retry.
  if (claim.kind === 'unavailable') return new NextResponse('', { status: 503 });
  if (claim.kind !== 'claimed') {
    return new NextResponse(wrapTwiml(twimlSay(tr('voicemail.thankYouGoodbye')), twimlHangup()), {
      headers: { 'content-type': 'application/xml' },
    });
  }
  const db = withGuardianTables(supabase) as SupabaseClient<VoicemailDatabase>;
  const gFrom = (t: 'guardian_communications') => db.from(t);

  try {
    // A failed or missing required read cannot be treated as an unknown caller.
    const loaded = await smsStep(signal, current => gFrom('guardian_communications')
      .select('id, family_id, member_id, from_number, from_name').eq('id', commId)
      .limit(2).retry(false).abortSignal(current));
    if (loaded.error || !Array.isArray(loaded.data) || loaded.data.length !== 1 || loaded.data[0].id !== commId) throw new Error('Voicemail communication unavailable');
    const typedComm = loaded.data[0] as {
      id: string;
      family_id: string;
      member_id: string | null;
      from_number: string | null;
      from_name: string | null;
    };

    const recording = {
      status: 'handled',
      call_recording_url: recordingUrl,
      call_duration_secs: recordingDuration,
      body: transcriptionText,
      summary: transcriptionText
        ? `Voicemail from ${typedComm.from_name ?? formatPhone(typedComm.from_number)}: "${transcriptionText.slice(0, 120)}"`
        : `Voicemail received from ${typedComm.from_name ?? formatPhone(typedComm.from_number)}`,
      ended_at: new Date().toISOString(),
    };
    await requireGuardianVoicemailLease(supabase, claim.lease, signal);
    // Reconcile a lost update response by reading the same permanent row.
    // That exact READBACK below is this write's confirmation — stricter than a
    // row count, which is why it asks no `.select()`. Audit C1-S9-69.
    try {
      await smsStep(signal, current => gFrom('guardian_communications').update(recording)
        .eq('id', commId).eq('family_id', typedComm.family_id).retry(false).abortSignal(current));
    } catch { /* Exact readback decides whether the recording was saved. */ }
    const saved = await smsStep(signal, current => gFrom('guardian_communications')
      .select('id,family_id,status,call_recording_url,call_duration_secs,body,summary,ended_at')
      .eq('id', commId).eq('family_id', typedComm.family_id).limit(2).retry(false).abortSignal(current));
    if (saved.error || !Array.isArray(saved.data) || saved.data.length !== 1 || saved.data[0].id !== commId
      || saved.data[0].family_id !== typedComm.family_id || !Object.entries(recording).every(([key, value]) =>
        key === 'ended_at' ? Date.parse(String(saved.data![0][key])) === Date.parse(String(value)) : saved.data![0][key as keyof typeof recording] === value)) {
      throw new Error('Voicemail recording was not saved');
    }

    // Notify family
    const callerDisplay = typedComm.from_name ?? formatPhone(typedComm.from_number);
    const bodyText = transcriptionText
      ? `"${transcriptionText.slice(0, 100)}${transcriptionText.length > 100 ? '…' : ''}"`
      : 'Tap to listen to the voicemail.';

    // A voicemail is a message waiting, not an emergency: it obeys quiet
    // hours like the text and WhatsApp routes. The caller has already hung up,
    // so nothing is lost by telling the family when they are awake.
    const scope = await guardianSmsScope(supabase, typedComm.family_id, signal);
    const notified = await notifyGuardianSms(scope, {
        recipients: 'family',
        type: 'system',
        title: `📩 Voicemail from ${callerDisplay}`,
        body: bodyText,
        relatedType: 'guardian_communications',
        relatedId: commId,
      }, { receiptId: guardianVoicemailReceiptId(recordingSid), signal,
        beforeWrite: () => requireGuardianVoicemailLease(supabase, claim.lease, signal) });
    if (!notified.ok || !await finishGuardianVoicemail(supabase, claim.lease, signal)) throw new Error('Voicemail completion unavailable');
  } catch {
    // An error lease is immediately recoverable; a stale worker cannot release
    // a newer worker's token. Bound cleanup separately after a request timeout.
    await releaseGuardianVoicemail(supabase, claim.lease, AbortSignal.timeout(2000));
    return new NextResponse('', { status: 503 });
  }
  return new NextResponse(
    wrapTwiml(twimlSay(tr('voicemail.thankYouForYourMessage')), twimlHangup()),
    { headers: { 'content-type': 'application/xml' } },
  );
}
