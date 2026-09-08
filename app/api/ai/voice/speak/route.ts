import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { authenticateAI } from '@/lib/server/ai-access';
import { getOpenAIKey } from '@/lib/ai/settings';
import { prepareSpeechText, normalizeTtsVoice } from '@/lib/ai/voice';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';
import { MAX_SMALL_JSON_BYTES, readBoundedRequestJson } from '@/lib/server/bounded-request-body';
import { readBoundedResponseText } from '@/lib/server/bounded-response-body';
import { fetchExternal } from '@/lib/server/external-fetch';

export const runtime = 'nodejs';
export const maxDuration = 60;

// Text-to-speech for "AI speaks back". Takes assistant text + an optional voice,
// returns an MP3 stream from OpenAI's speech endpoint. The key stays server-side.
// Honest 503 when OpenAI isn't configured — never synthesizes a fake/silent clip.
//
// Auth is `authenticateAI` — the same cookie-or-bearer resolver /api/ai uses —
// so the phone can be spoken to as well as the browser, and an anonymous caller
// gets a JSON 401.
export async function POST(req: NextRequest) {
  const t = await getTranslations();
  try {
    const authed = await authenticateAI(req);
    if (authed instanceof NextResponse) return authed;
    const { supabase, ctx } = authed;
    const limited = await enforceAIRateLimit(supabase, `ai-voice-speak:${ctx.user.id}`, { limit: 30 });
    if (!limited.ok) return NextResponse.json(
      { error: t('speak.tooManyVoiceRequestsPlease') },
      { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
    );
    const apiKey = await getOpenAIKey(supabase);
    if (!apiKey) {
      return NextResponse.json(
        { error: t('speak.voiceIsnTConfiguredAdd') },
        { status: 503 },
      );
    }

    const boundedBody = await readBoundedRequestJson(req, MAX_SMALL_JSON_BYTES);
    if (!boundedBody.ok) return NextResponse.json({ error: boundedBody.reason === 'too_large' ? 'Request body is too large.' : 'Invalid request body' }, { status: 400 });
    const { text, voice } = (boundedBody.value ?? {}) as { text?: string; voice?: string };
    const speech = prepareSpeechText(text ?? '');
    if (!speech) return NextResponse.json({ error: t('speak.nothingToSay') }, { status: 400 });

    const model = process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts';
    const res = await fetchExternal('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        input: speech,
        voice: normalizeTtsVoice(voice ?? process.env.OPENAI_TTS_VOICE),
        response_format: 'mp3',
      }),
    }, 60_000);

    if (!res.ok || !res.body) {
      const bounded = await readBoundedResponseText(res, 64 * 1024);
      const detail = bounded.ok ? bounded.text : '[provider error response exceeded 64 KiB]';
      console.error('OpenAI TTS error', res.status, detail);
      const msg = res.status === 429
        ? 'The AI engine is busy. Please try again in a moment.'
        : 'Could not generate speech. Please try again.';
      return NextResponse.json({ error: msg }, { status: 502 });
    }

    return new Response(res.body, {
      headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    console.error('TTS route error', err);
    return NextResponse.json({ error: t('speak.somethingWentWrongPleaseTry') }, { status: 500 });
  }
}
