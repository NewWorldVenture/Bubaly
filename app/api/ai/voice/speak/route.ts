import { NextRequest, NextResponse } from 'next/server';
import { createServer } from '@/lib/supabase/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { getOpenAIKey } from '@/lib/ai/settings';
import { prepareSpeechText, normalizeTtsVoice } from '@/lib/ai/voice';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';
import { MAX_SMALL_JSON_BYTES, readBoundedRequestJson } from '@/lib/server/bounded-request-body';
import { readBoundedResponseText } from '@/lib/server/bounded-response-body';

export const runtime = 'nodejs';
export const maxDuration = 60;

// Text-to-speech for "AI speaks back". Takes assistant text + an optional voice,
// returns an MP3 stream from OpenAI's speech endpoint. The key stays server-side.
// Honest 503 when OpenAI isn't configured — never synthesizes a fake/silent clip.
export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const supabase = await createServer();
    const limited = await enforceAIRateLimit(supabase, `ai-voice-speak:${ctx.user.id}`, { limit: 30 });
    if (!limited.ok) return NextResponse.json(
      { error: 'Too many voice requests. Please try again shortly.' },
      { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
    );
    const apiKey = await getOpenAIKey(supabase);
    if (!apiKey) {
      return NextResponse.json(
        { error: 'Voice isn’t configured. Add an OpenAI key in Admin → AI Engine.' },
        { status: 503 },
      );
    }

    const boundedBody = await readBoundedRequestJson(req, MAX_SMALL_JSON_BYTES);
    if (!boundedBody.ok) return NextResponse.json({ error: boundedBody.reason === 'too_large' ? 'Request body is too large.' : 'Invalid request body' }, { status: 400 });
    const { text, voice } = (boundedBody.value ?? {}) as { text?: string; voice?: string };
    const speech = prepareSpeechText(text ?? '');
    if (!speech) return NextResponse.json({ error: 'Nothing to say' }, { status: 400 });

    const model = process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts';
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        input: speech,
        voice: normalizeTtsVoice(voice ?? process.env.OPENAI_TTS_VOICE),
        response_format: 'mp3',
      }),
    });

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
    return NextResponse.json({ error: 'Something went wrong. Please try again.' }, { status: 500 });
  }
}
