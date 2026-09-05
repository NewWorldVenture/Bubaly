// app/api/ai/requests/route.ts — the Ask Bubaly entry (§1, §4.3, §52).
//
//   POST /api/ai/requests  { text, conversationId?, context?, answers?, clientRequestId? }
//     → 202 { requestId, runId, planId, outcome, summary, redirect, question? }
//     → 200 with the same body when the `Idempotency-Key` header (or
//       `clientRequestId`) names a request this family already filed: a
//       retried POST gets the first answer back, never a second plan.
//
// The response is sent once the plan is persisted and BEFORE any step runs:
// execution starts in `after()` with whatever is left of this invocation, and
// the cron carries anything longer. That is why `maxDuration` is 300 here
// while the planner itself is held to ~20 s — the person waits for a plan,
// never for a tool call.
//
// Auth is the same as /api/ai (cookie session or bearer JWT), the body is
// bounded before it is parsed, the durable rate limit answers 429 with
// Retry-After, and the feature/allowance gate runs before a request row is
// written so a family with the concierge turned off leaves no trace.
import { NextRequest, NextResponse } from 'next/server';
import { isAIConfigured } from '@/lib/ai/provider';
import { parseAIRequestIntake } from '@/lib/ai/chat-request';
import { statusForServiceCode, submitRequest } from '@/lib/ai/runs/intake';
import { accessDeniedResponse, assertAIAccess, authenticateAI } from '@/lib/server/ai-access';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';
import { MAX_SMALL_JSON_BYTES, readBoundedRequestJson } from '@/lib/server/bounded-request-body';
import { scopeFromUserContext } from '@/lib/services/scope';

export const runtime = 'nodejs';
export const maxDuration = 300;

const REQUEST_RATE_LIMIT = { limit: 20, windowMs: 60_000 } as const;

const PARSE_ERRORS = {
  invalid_body: 'Invalid request body',
  text_required: 'Tell Bubaly what you need.',
  text_too_long: 'That request is too long. Try a shorter one.',
  conversation_invalid: 'conversationId must be a valid UUID',
  client_request_id_invalid: 'Idempotency-Key / clientRequestId must be 8–128 characters of letters, digits, ".", "_", ":" or "-"',
} as const;

export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  try {
    const authed = await authenticateAI(req);
    if (authed instanceof NextResponse) return authed;
    const { supabase, ctx } = authed;

    const limited = await enforceAIRateLimit(supabase, `ai-requests:${ctx.user.id}`, REQUEST_RATE_LIMIT);
    if (!limited.ok) {
      return NextResponse.json(
        { error: 'Too many requests. Please try again shortly.', code: 'rate_limited' },
        { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
      );
    }

    const body = await readBoundedRequestJson(req, MAX_SMALL_JSON_BYTES);
    if (!body.ok) {
      if (body.reason === 'too_large') return NextResponse.json({ error: 'Request body is too large.', code: 'too_large' }, { status: 413 });
      return NextResponse.json({ error: 'Invalid request body', code: 'invalid_body' }, { status: 400 });
    }
    const parsed = parseAIRequestIntake(body.value, { idempotencyKey: req.headers.get('idempotency-key') });
    if (!parsed.ok) return NextResponse.json({ error: PARSE_ERRORS[parsed.error], code: parsed.error }, { status: 400 });

    const access = await assertAIAccess(ctx, { db: supabase });
    if (!access.ok) return accessDeniedResponse(access);

    // The scripted provider (AI_PROVIDER_STUB) needs no key; see lib/ai/provider-stub.ts.
    if (!(await isAIConfigured())) {
      return NextResponse.json({ error: 'The AI engine isn’t set up yet. Add an OpenAI API key in Admin → AI Engine.', code: 'not_configured' }, { status: 503 });
    }

    const scope = scopeFromUserContext(ctx, supabase);
    const result = await submitRequest(scope, parsed.value, { startedAtMs: startedAt });
    if (!result.ok) {
      return NextResponse.json({ error: result.error, code: result.code ?? 'request_failed' }, { status: statusForServiceCode(result.code, result.retryable) });
    }
    // A replay is not "accepted for planning": it is the answer the first
    // submission already produced, so it is a plain 200.
    const { replayed, ...response } = result.data;
    return NextResponse.json(response, { status: replayed ? 200 : 202 });
  } catch (error) {
    console.error('[api/ai/requests] request intake failed', error);
    return NextResponse.json({ error: 'Bubaly could not take that request right now.', code: 'unknown' }, { status: 500 });
  }
}
