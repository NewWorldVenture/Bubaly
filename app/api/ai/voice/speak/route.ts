import { NextRequest, NextResponse } from 'next/server';
import { assertAIRequestFamily, getAIRequestTranslations } from '@/lib/server/ai-request-context';
import { authenticateAI, refuseOverAIAllowance } from '@/lib/server/ai-access';
import { getOpenAIKey } from '@/lib/ai/settings';
import { prepareSpeechText, normalizeTtsVoice } from '@/lib/ai/voice';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';
import { MAX_SMALL_JSON_BYTES, readBoundedRequestJson } from '@/lib/server/bounded-request-body';
import { readBoundedResponseText } from '@/lib/server/bounded-response-body';
import { fetchWithDeadline } from '@/lib/server/fetch-with-deadline';
import { ProviderHttpError } from '@/lib/server/provider-http-error';
import { withAiRequest } from '@/lib/ai/observability';
import { scopeFromUserContext } from '@/lib/services/scope';

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
  const t = await getAIRequestTranslations(req);
  try {
    const authed = await authenticateAI(req);
    if (authed instanceof NextResponse) return authed;
    const { supabase, ctx } = authed;
    const familyError = assertAIRequestFamily(req, ctx.active.familyId, t);
    if (familyError) return familyError;
    const limited = await enforceAIRateLimit(supabase, `ai-voice-speak:${ctx.user.id}`, { limit: 30 });
    if (!limited.ok) return NextResponse.json(
      { error: t('speak.tooManyVoiceRequestsPlease') },
      { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
    );
    const apiKey = await getOpenAIKey(supabase);
    if (!apiKey) {
      return NextResponse.json(
        { error: t('speak.voiceIsnTConfiguredAdd'), code: 'not_configured' },
        { status: 503 },
      );
    }

    const boundedBody = await readBoundedRequestJson(req, MAX_SMALL_JSON_BYTES);
    if (!boundedBody.ok) return NextResponse.json({ error: boundedBody.reason === 'too_large' ? 'Request body is too large.' : 'Invalid request body' }, { status: 400 });
    const { text, voice } = (boundedBody.value ?? {}) as { text?: string; voice?: string };
    const speech = prepareSpeechText(text ?? '');
    if (!speech) return NextResponse.json({ error: t('speak.nothingToSay') }, { status: 400 });

    const model = process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts';
    // F19: past the monthly allowance this is refused before the provider.
    const overAllowance = await refuseOverAIAllowance(authed.ctx, authed.supabase);
    if (overAllowance) return overAllowance;
    // Recorded as its own request, so it counts against the allowance (F19).
    // Nothing ties a speech call to an assistant turn the family already paid
    // for, so treating it as part of one let it be called on its own, without
    // end, at no cost to the count. A provider error is thrown inside the
    // observed body, so the row says `failed`.
    let res: Response;
    try {
      res = await withAiRequest(
        scopeFromUserContext(authed.ctx, authed.supabase),
        { feature: 'voice.speak', text: 'voice:speak' },
        async (obs) => {
          const out = await fetchWithDeadline('https://api.openai.com/v1/audio/speech', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
              model,
              input: speech,
              voice: normalizeTtsVoice(voice ?? process.env.OPENAI_TTS_VOICE),
              response_format: 'mp3',
            }),
          }, 60_000);
          obs.used(model, null);
          if (!out.ok || !out.body) {
            const bounded = await readBoundedResponseText(out, 64 * 1024);
            throw new ProviderHttpError(out.status, bounded.ok ? bounded.text : '[provider error response exceeded 64 KiB]');
          }
          return out;
        },
      );
    } catch (err) {
      if (!(err instanceof ProviderHttpError)) throw err;
      console.error('OpenAI TTS error', err.status, err.detail);
      const msg = err.status === 429
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
