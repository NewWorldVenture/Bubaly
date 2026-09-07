// POST /api/ai/runs/[id]/answer  { answer } — answer the question a run is
// waiting on. The answer is recorded on the request, the SAME request is
// planned again (next plan version) and the run continues; the response is
// the same shape as POST /api/ai/requests so the Ask bar handles both.
//
// The planner runs here, so this route carries the same duration as intake,
// the same durable rate limit (an answer is a model call, not a status poke)
// and the same feature/plan/allowance gate: an answer re-plans and then
// executes with the run's authority, exactly what a family whose concierge is
// off or lapsed must not be able to start from a parked run.
import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { MAX_AI_ANSWER_CHARS } from '@/lib/ai/chat-request';
import { answerClarification, statusForServiceCode } from '@/lib/ai/runs/intake';
import { accessDeniedResponse, assertAIAccess, authenticateAI } from '@/lib/server/ai-access';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';
import { MAX_SMALL_JSON_BYTES, readBoundedRequestJson } from '@/lib/server/bounded-request-body';
import { scopeFromUserContext } from '@/lib/services/scope';

export const runtime = 'nodejs';
export const maxDuration = 300;

const ANSWER_RATE_LIMIT = { limit: 20, windowMs: 60_000 } as const;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const t = await getTranslations();
  const startedAt = Date.now();
  try {
    const authed = await authenticateAI(req);
    if (authed instanceof NextResponse) return authed;
    const { supabase, ctx } = authed;
    const { id } = await params;
    if (!id) return NextResponse.json({ error: t('answer.runNotFound'), code: 'not_found' }, { status: 404 });

    const limited = await enforceAIRateLimit(supabase, `ai-requests:${ctx.user.id}`, ANSWER_RATE_LIMIT);
    if (!limited.ok) {
      return NextResponse.json(
        { error: t('answer.tooManyRequestsPleaseTry'), code: 'rate_limited' },
        { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
      );
    }

    const body = await readBoundedRequestJson(req, MAX_SMALL_JSON_BYTES);
    if (!body.ok) {
      if (body.reason === 'too_large') return NextResponse.json({ error: t('answer.requestBodyIsTooLarge'), code: 'too_large' }, { status: 413 });
      return NextResponse.json({ error: t('answer.invalidRequestBody'), code: 'invalid_body' }, { status: 400 });
    }
    const record = body.value && typeof body.value === 'object' ? (body.value as Record<string, unknown>) : {};
    const answer = typeof record.answer === 'string' ? record.answer.trim() : '';
    if (!answer) return NextResponse.json({ error: t('answer.typeAnAnswerForBubaly'), code: 'answer_required' }, { status: 400 });
    if (answer.length > MAX_AI_ANSWER_CHARS) return NextResponse.json({ error: t('answer.thatAnswerIsTooLong'), code: 'answer_too_long' }, { status: 400 });

    const access = await assertAIAccess(ctx, { db: supabase });
    if (!access.ok) return accessDeniedResponse(access);

    const scope = scopeFromUserContext(ctx, supabase);
    const result = await answerClarification(scope, id, answer, { startedAtMs: startedAt });
    if (!result.ok) return NextResponse.json({ error: result.error, code: result.code ?? 'answer_failed' }, { status: statusForServiceCode(result.code, result.retryable) });
    return NextResponse.json(result.data, { status: 202 });
  } catch (error) {
    console.error('[api/ai/runs/answer] answer failed', error);
    return NextResponse.json({ error: t('answer.bubalyCouldNotTakeThat'), code: 'unknown' }, { status: 500 });
  }
}
