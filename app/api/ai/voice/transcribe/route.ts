import { NextRequest, NextResponse } from 'next/server';
import { refuseClosedOrTrialEnded } from '@/lib/server/account-standing';
import { assertAIRequestFamily, getAIRequestTranslations } from '@/lib/server/ai-request-context';
import { authenticateAI, refuseOverAIAllowance } from '@/lib/server/ai-access';
import { getOpenAIKey } from '@/lib/ai/settings';
import { cleanTranscript, isValidAudioUpload, VOICE_COMMAND_MAX_BYTES } from '@/lib/ai/voice';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';
import { readBoundedRequestFormData } from '@/lib/server/bounded-request-body';
import { readBoundedResponseJson, readBoundedResponseText } from '@/lib/server/bounded-response-body';
import { fetchWithDeadline } from '@/lib/server/fetch-with-deadline';

export const runtime = 'nodejs';

const COULD_NOT_TRANSCRIBE = 'Could not transcribe that recording. Please try again.';
export const maxDuration = 60;
/** The recording plus the multipart framing around it. */
const MAX_AUDIO_REQUEST_BYTES = VOICE_COMMAND_MAX_BYTES + 64 * 1024;

// Speech-to-text for "talk to AI". Accepts a recorded audio blob (multipart),
// forwards it to OpenAI's transcription endpoint, and returns the text. The key
// never leaves the server. Honest 503 when OpenAI isn't configured — no faked
// transcript is ever returned.
//
// Auth is `authenticateAI` — the SAME resolver /api/ai uses — so the cookie
// session (web) and `Authorization: Bearer <supabase jwt>` (the Expo app) reach
// the same place, and an anonymous caller gets a 401 in JSON rather than a
// redirect the phone cannot follow.
export async function POST(req: NextRequest) {
  const t = await getAIRequestTranslations(req);
  try {
    const authed = await authenticateAI(req);
    if (authed instanceof NextResponse) return authed;
    const { supabase, ctx } = authed;
    const familyError = assertAIRequestFamily(req, ctx.active.familyId, t);
    if (familyError) return familyError;
    // A closed or trial-ended family is refused before any work: see lib/server/account-standing.ts.
    const refused = await refuseClosedOrTrialEnded(supabase, ctx.active.familyId);
    if (refused) return refused;
    const limited = await enforceAIRateLimit(supabase, `ai-voice-transcribe:${ctx.user.id}`, { limit: 10 });
    if (!limited.ok) return NextResponse.json(
      { error: t('transcribe.tooManyVoiceRequestsPlease') },
      { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
    );
    // A paid model call: the Free plan's monthly allowance applies, so a family
    // past its month cannot keep a voice exchange going. The allowance alone,
    // not the assistant's tier or its Off switch: voice is how a member types
    // into the concierge's Ask bar and the command bar too, and switching the
    // assistant Off must not take the microphone off those.
    //
    // F19, the owner's decision of 2026-10-02: one spoken exchange counts as
    // ONE request, the assistant turn it carries, which files its own row.
    // Transcription therefore files nothing. Recording it as well (main's N17)
    // would count each exchange twice, and an exchange admitted at 9 of 10
    // would spend the tenth here and then be refused its own turn.
    const overAllowance = await refuseOverAIAllowance(ctx, supabase, t);
    if (overAllowance) return overAllowance;
    const apiKey = await getOpenAIKey(supabase);
    if (!apiKey) {
      return NextResponse.json(
        { error: t('transcribe.voiceIsnTConfiguredAdd'), code: 'not_configured' },
        { status: 503 },
      );
    }

    const boundedForm = await readBoundedRequestFormData(req, MAX_AUDIO_REQUEST_BYTES);
    if (!boundedForm.ok) {
      return NextResponse.json(
        { error: boundedForm.reason === 'too_large' ? t('transcribe.recordingTooLong') : 'Invalid audio upload' },
        { status: boundedForm.reason === 'too_large' ? 413 : 400 },
      );
    }
    const file = boundedForm.value.get('audio');
    if (!(file instanceof Blob)) {
      return NextResponse.json({ error: t('transcribe.noAudioProvided') }, { status: 400 });
    }
    if (file.size > VOICE_COMMAND_MAX_BYTES) return NextResponse.json({ error: t('transcribe.recordingTooLong') }, { status: 413 });
    const check = isValidAudioUpload(file.size, file.type, VOICE_COMMAND_MAX_BYTES);
    if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 });

    const model = process.env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1';
    const filename = (file as File).name || 'speech.webm';

    const upstream = new FormData();
    upstream.append('file', file, filename);
    upstream.append('model', model);
    upstream.append('response_format', 'json');

    const res = await fetchWithDeadline('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}` },
      body: upstream,
    }, 60_000);

    if (!res.ok) {
      const bounded = await readBoundedResponseText(res, 64 * 1024);
      const detail = bounded.ok ? bounded.text : '[provider error response exceeded 64 KiB]';
      console.error('OpenAI transcription error', res.status, detail);
      const msg = res.status === 429
        ? 'The AI engine is busy. Please try again in a moment.'
        : COULD_NOT_TRANSCRIBE;
      return NextResponse.json({ error: msg }, { status: 502 });
    }

    // A 200 whose body is unreadable, or whose `text` is not a string, is a
    // provider failure: the caller gets the same 502 as a provider error, not a
    // 500 from a parse or a string method on a number.
    let body: { text?: unknown };
    try {
      body = await readBoundedResponseJson<{ text?: unknown }>(res, 256 * 1024);
    } catch (parseErr) {
      console.error('OpenAI transcription returned an unreadable body', parseErr);
      return NextResponse.json({ error: COULD_NOT_TRANSCRIBE }, { status: 502 });
    }
    if (body?.text !== undefined && body?.text !== null && typeof body.text !== 'string') {
      console.error('OpenAI transcription returned a non-string text field', typeof body.text);
      return NextResponse.json({ error: COULD_NOT_TRANSCRIBE }, { status: 502 });
    }
    const text = cleanTranscript(typeof body?.text === 'string' ? body.text : '');
    if (!text) {
      return NextResponse.json({ error: t('transcribe.iCouldnTHearAnything') }, { status: 422 });
    }
    return NextResponse.json({ text });
  } catch (err) {
    console.error('Transcription route error', err);
    return NextResponse.json({ error: t('transcribe.somethingWentWrongPleaseTry') }, { status: 500 });
  }
}
