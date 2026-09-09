import { NextRequest, NextResponse } from 'next/server';
import { assertAIRequestFamily, getAIRequestTranslations } from '@/lib/server/ai-request-context';
import { authenticateAI } from '@/lib/server/ai-access';
import { getOpenAIKey } from '@/lib/ai/settings';
import { cleanTranscript, isValidAudioUpload } from '@/lib/ai/voice';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';
import { readBoundedRequestFormData } from '@/lib/server/bounded-request-body';
import { readBoundedResponseJson, readBoundedResponseText } from '@/lib/server/bounded-response-body';
import { fetchExternal } from '@/lib/server/external-fetch';

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

    const res = await fetchExternal('https://api.openai.com/v1/audio/transcriptions', {
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
        : 'Could not transcribe that recording. Please try again.';
      return NextResponse.json({ error: msg }, { status: 502 });
    }

    const data = await readBoundedResponseJson<{ text?: string }>(res, 256 * 1024);
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
