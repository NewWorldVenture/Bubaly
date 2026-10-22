import { NextRequest, NextResponse } from 'next/server';
import { refuseClosedOrTrialEnded } from '@/lib/server/account-standing';
import { assertAIRequestFamily, getAIRequestTranslations } from '@/lib/server/ai-request-context';
import { AI_ASSISTANT_FEATURE_KEY, accessDeniedResponse, assertAIAccess, authenticateAI } from '@/lib/server/ai-access';
import { withAiRequest } from '@/lib/ai/observability';
import { scopeFromUserContext } from '@/lib/services/scope';
import { isCountedExchange } from '@/lib/ai/voice-exchange';
import { getOpenAIKey } from '@/lib/ai/settings';
import { prepareSpeechText, normalizeTtsVoice } from '@/lib/ai/voice';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';
import { MAX_SMALL_JSON_BYTES, readBoundedRequestJson } from '@/lib/server/bounded-request-body';
import { readBoundedResponseText } from '@/lib/server/bounded-response-body';
import { fetchWithDeadline } from '@/lib/server/fetch-with-deadline';

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
    // A closed or trial-ended family is refused before any work: see lib/server/account-standing.ts.
    const refused = await refuseClosedOrTrialEnded(supabase, ctx.active.familyId);
    if (refused) return refused;
    const limited = await enforceAIRateLimit(supabase, `ai-voice-speak:${ctx.user.id}`, { limit: 30 });
    if (!limited.ok) return NextResponse.json(
      { error: t('speak.tooManyVoiceRequestsPlease') },
      { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
    );
    const boundedBody = await readBoundedRequestJson(req, MAX_SMALL_JSON_BYTES);
    if (!boundedBody.ok) return NextResponse.json({ error: boundedBody.reason === 'too_large' ? 'Request body is too large.' : 'Invalid request body' }, { status: 400 });
    const { text, voice, exchangeId } = (boundedBody.value ?? {}) as { text?: string; voice?: string; exchangeId?: unknown };
    const speech = prepareSpeechText(text ?? '');
    if (!speech) return NextResponse.json({ error: t('speak.nothingToSay') }, { status: 400 });

    // F19, the owner's decision of 2026-10-02: one spoken exchange counts as
    // ONE request, the assistant turn, which files its own row and passed the
    // assistant's gate. Speaking that turn's own answer (`exchangeId`, the
    // turn's row) is part of an exchange already counted, so it is neither
    // checked nor recorded again: an exchange admitted at 9 of 10 must be able
    // to finish speaking after its own turn took the count to 10. Speech that
    // names no such turn is a paid model call of its own: the plan, the
    // assistant's switch and the Free plan's allowance apply, and it is
    // recorded where that allowance counts it.
    const counted = await isCountedExchange(supabase, { familyId: ctx.active.familyId, userId: ctx.user.id }, exchangeId, text ?? '');
    if (!counted) {
      const access = await assertAIAccess(ctx, { db: supabase, featureKey: AI_ASSISTANT_FEATURE_KEY });
      if (!access.ok) return accessDeniedResponse(access, t);
    }
    const apiKey = await getOpenAIKey(supabase);
    if (!apiKey) {
      return NextResponse.json(
        { error: t('speak.voiceIsnTConfiguredAdd'), code: 'not_configured' },
        { status: 503 },
      );
    }

    const model = process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts';
    const speak = () => fetchWithDeadline('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        input: speech,
        voice: normalizeTtsVoice(voice ?? process.env.OPENAI_TTS_VOICE),
        response_format: 'mp3',
      }),
    }, 60_000);
    const res = counted ? await speak() : await withAiRequest(
      scopeFromUserContext(ctx, supabase),
      { feature: 'voice.speak', text: 'Speak an answer aloud' },
      async (obs) => {
        const answer = await speak();
        obs.used(model);
        if (!answer.ok || !answer.body) obs.failed(new Error(`The speech provider answered ${answer.status}.`));
        return answer;
      },
    );

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
