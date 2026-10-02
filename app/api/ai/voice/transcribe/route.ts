import { NextRequest, NextResponse } from 'next/server';
import { assertAIRequestFamily, getAIRequestTranslations } from '@/lib/server/ai-request-context';
import { authenticateAI, refuseOverAIAllowance } from '@/lib/server/ai-access';
import { getOpenAIKey } from '@/lib/ai/settings';
import { cleanTranscript, isValidAudioUpload } from '@/lib/ai/voice';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';
import { readBoundedRequestFormData } from '@/lib/server/bounded-request-body';
import { readBoundedResponseJson, readBoundedResponseText } from '@/lib/server/bounded-response-body';
import { fetchWithDeadline } from '@/lib/server/fetch-with-deadline';
import { ProviderHttpError } from '@/lib/server/provider-http-error';
import { withAiRequest } from '@/lib/ai/observability';
import { scopeFromUserContext } from '@/lib/services/scope';

export const runtime = 'nodejs';
export const maxDuration = 60;
const MAX_AUDIO_REQUEST_BYTES = 26 * 1024 * 1024;

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
    const limited = await enforceAIRateLimit(supabase, `ai-voice-transcribe:${ctx.user.id}`, { limit: 10 });
    if (!limited.ok) return NextResponse.json(
      { error: t('transcribe.tooManyVoiceRequestsPlease') },
      { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
    );
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
        { error: boundedForm.reason === 'too_large' ? 'Recording too large (max 25 MB)' : 'Invalid audio upload' },
        { status: boundedForm.reason === 'too_large' ? 413 : 400 },
      );
    }
    const file = boundedForm.value.get('audio');
    if (!(file instanceof Blob)) {
      return NextResponse.json({ error: t('transcribe.noAudioProvided') }, { status: 400 });
    }
    const check = isValidAudioUpload(file.size, file.type);
    if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 });

    const model = process.env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1';
    const filename = (file as File).name || 'speech.webm';

    const upstream = new FormData();
    upstream.append('file', file, filename);
    upstream.append('model', model);
    upstream.append('response_format', 'json');

    // F19: past the monthly allowance this is refused before the provider.
    const overAllowance = await refuseOverAIAllowance(authed.ctx, authed.supabase);
    if (overAllowance) return overAllowance;
    // Recorded as its own request, so it counts against the allowance (F19).
    // A transcription runs before any assistant turn exists and nothing ties
    // it to one, so it is a paid model call of its own. A provider error is
    // thrown inside the observed body, so the row says `failed`.
    let data: { text?: string };
    try {
      data = await withAiRequest(
        scopeFromUserContext(authed.ctx, authed.supabase),
        { feature: 'voice.transcribe', text: 'voice:transcribe' },
        async (obs) => {
          const res = await fetchWithDeadline('https://api.openai.com/v1/audio/transcriptions', {
            method: 'POST',
            headers: { authorization: `Bearer ${apiKey}` },
            body: upstream,
          }, 60_000);
          obs.used(model, null);
          if (!res.ok) {
            const bounded = await readBoundedResponseText(res, 64 * 1024);
            throw new ProviderHttpError(res.status, bounded.ok ? bounded.text : '[provider error response exceeded 64 KiB]');
          }
          return readBoundedResponseJson<{ text?: string }>(res, 256 * 1024);
        },
      );
    } catch (err) {
      if (!(err instanceof ProviderHttpError)) throw err;
      console.error('OpenAI transcription error', err.status, err.detail);
      const msg = err.status === 429
        ? 'The AI engine is busy. Please try again in a moment.'
        : 'Could not transcribe that recording. Please try again.';
      return NextResponse.json({ error: msg }, { status: 502 });
    }

    const text = cleanTranscript(data.text ?? '');
    if (!text) {
      return NextResponse.json({ error: t('transcribe.iCouldnTHearAnything') }, { status: 422 });
    }
    return NextResponse.json({ text });
  } catch (err) {
    console.error('Transcription route error', err);
    return NextResponse.json({ error: t('transcribe.somethingWentWrongPleaseTry') }, { status: 500 });
  }
}
