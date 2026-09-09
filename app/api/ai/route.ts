// app/api/ai/route.ts — the canonical AI assistant endpoint.
//
//   POST /api/ai            { conversationId, message }  → SSE stream (default)
//   POST /api/ai?mode=json  or  Accept: application/json  → one JSON result
//   GET  /api/ai            → capability manifest (transports, auth, tools)
//
// Auth: the web app's cookie session OR `Authorization: Bearer <supabase jwt>`
// (the Expo mobile app). Either way every tool runs under the caller's RLS.
// The assistant executes the shared toolbox plus every lib/ai/actions.ts
// action (see lib/ai/assistant-engine.ts).
import { NextRequest, NextResponse } from 'next/server';
import { assertAIRequestFamily, getAIRequestTranslations } from '@/lib/server/ai-request-context';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createServer } from '@/lib/supabase/server';
import { getUserContext, type UserContext } from '@/lib/supabase/auth';
import { extractBearerToken, getBearerUserContext } from '@/lib/supabase/bearer';
import { ensureActiveFamily } from '@/lib/server/ensure-family';
import { describeAIError, isAIConfigured } from '@/lib/ai/provider';
import { rateLimit } from '@/lib/server/rate-limit';
import { rateLimitDb } from '@/lib/server/rate-limit-db';
import { parseAIChatRequest } from '@/lib/ai/chat-request';
import { MAX_PROVIDER_JSON_BYTES, readBoundedRequestJson } from '@/lib/server/bounded-request-body';
import { describeActionError } from '@/lib/supabase/errors';
import { buildAssistantTools } from '@/lib/assistant/tools';
import { buildActionTools, mergeToolSets } from '@/lib/ai/action-tools';
import {
  SSE_HEADERS, createAssistantStream, prepareAssistantTurn, runAssistantTurn, wantsJsonTransport, type AssistantTurnInput,
} from '@/lib/ai/assistant-engine';

export const runtime = 'nodejs';
export const maxDuration = 60;

type DB = SupabaseClient<Database>;
type Authed = { supabase: DB; ctx: UserContext; via: 'bearer' | 'cookie' };

const AI_RATE_LIMIT = { limit: 20, windowMs: 60_000 } as const;

function unauthorized(message: string, code: string) {
  return NextResponse.json({ error: message, code }, { status: 401 });
}

/** Resolve the caller from a bearer token (mobile) or the cookie session (web). */
async function authenticate(req: NextRequest): Promise<Authed | NextResponse> {
  const tr = await getAIRequestTranslations(req);
  const token = extractBearerToken(req.headers.get('authorization'));
  if (token) {
    const bearer = await getBearerUserContext(token);
    if (bearer.ok) return { supabase: bearer.supabase, ctx: bearer.ctx, via: 'bearer' };
    if (bearer.reason === 'invalid_token') return unauthorized('Sign in to use the assistant.', 'invalid_token');
    if (bearer.reason === 'needs_family') {
      return NextResponse.json({ error: tr('ai.finishSettingUpYourFamily'), code: 'needs_family' }, { status: 403 });
    }
    return NextResponse.json({ error: tr('ai.accountContextIsTemporarilyUnavailable'), code: 'unavailable' }, { status: 503 });
  }

  const supabase = await createServer();
  let ctx = await getUserContext();
  if (!ctx) return unauthorized('Sign in to use the assistant.', 'signed_out');
  if ('needsFamily' in ctx) {
    // Same auto-provisioning as requireUserContext(), minus the redirect.
    const { data: auth } = await supabase.auth.getUser();
    if (auth.user && (await ensureActiveFamily(supabase, auth.user))) ctx = await getUserContext();
    if (!ctx || 'needsFamily' in ctx) {
      return NextResponse.json({ error: tr('ai.finishSettingUpYourFamily'), code: 'needs_family' }, { status: 403 });
    }
  }
  return { supabase, ctx, via: 'cookie' };
}

export async function GET(req: NextRequest) {
  try {
    const authed = await authenticate(req);
    if (authed instanceof NextResponse) return authed;
    const { supabase, ctx } = authed;
    const familyError = assertAIRequestFamily(req, ctx.active.familyId, await getAIRequestTranslations(req));
    if (familyError) return familyError;
    const scope = { familyId: ctx.active.familyId, userId: ctx.user.id };
    const tools = mergeToolSets(
      // Listing only: this GET reports tool names and descriptions and never
      // executes one, so an empty roster and no acting member are correct here.
      buildAssistantTools(supabase, { ...scope, memberId: null, members: [], tz: ctx.active.family.timezone || 'UTC' }),
      buildActionTools({ supabase, ...scope }),
    ).map((t) => ({ name: t.name, description: t.description }));
    return NextResponse.json({
      endpoint: '/api/ai',
      transports: ['sse', 'json'],
      auth: ['cookie', 'bearer'],
      configured: await isAIConfigured(),
      family: { id: ctx.active.familyId, name: ctx.active.family.name },
      tools,
    });
  } catch (err) {
    console.error('[api/ai] manifest error:', err);
    return NextResponse.json({ error: describeAIError(err).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const tr = await getAIRequestTranslations(req);
  try {
    const authed = await authenticate(req);
    if (authed instanceof NextResponse) return authed;
    const { supabase, ctx } = authed;
    const familyError = assertAIRequestFamily(req, ctx.active.familyId, tr);
    if (familyError) return familyError;
    const familyId = ctx.active.familyId;
    const tz = ctx.active.family.timezone || 'America/New_York';

    // Shared bucket with /api/ai/chat so web + mobile draw from one allowance.
    const key = `ai-chat:${ctx.user.id}`;
    const rejected = (retryAfter: number) => NextResponse.json(
      { error: tr('ai.tooManyAiRequestsPlease') },
      { status: 429, headers: { 'Retry-After': String(retryAfter) } },
    );
    const limited = rateLimit(key, AI_RATE_LIMIT);
    if (!limited.ok) return rejected(limited.retryAfter);
    const durable = await rateLimitDb(supabase, key, AI_RATE_LIMIT);
    if (!durable.ok) return rejected(durable.retryAfter);

    const boundedBody = await readBoundedRequestJson(req, MAX_PROVIDER_JSON_BYTES);
    if (!boundedBody.ok) {
      return NextResponse.json({ error: boundedBody.reason === 'too_large' ? 'Request body is too large.' : 'Invalid request body' }, { status: 400 });
    }
    const rawBody = boundedBody.value;
    const parsed = parseAIChatRequest(rawBody);
    if (!parsed.ok) {
      const messageByError = {
        invalid_body: 'Invalid request body',
        conversation_required: 'conversationId is required',
        conversation_invalid: 'conversationId must be a valid UUID',
        message_required: 'Message is required',
        message_too_long: 'Message is too long',
      } as const;
      return NextResponse.json({ error: messageByError[parsed.error], code: parsed.error }, { status: 400 });
    }
    const { conversationId, message } = parsed.value;
    const json = wantsJsonTransport(req, (rawBody && typeof rawBody === 'object' ? rawBody : {}) as Record<string, unknown>);

    if (!(await isAIConfigured())) {
      return NextResponse.json({ error: tr('ai.theAiEngineIsnT'), code: 'not_configured' }, { status: 503 });
    }

    // The client owns the conversation UUID, never its authorization boundary:
    // create-if-missing, then re-read through family AND user ownership.
    const { error: upsertError } = await supabase.from('ai_conversations').upsert(
      { id: conversationId, family_id: familyId, user_id: ctx.user.id },
      { onConflict: 'id', ignoreDuplicates: true },
    );
    if (upsertError) {
      console.error('[api/ai] conversation initialization failed', upsertError);
      return NextResponse.json({ error: describeActionError(upsertError, tr('ai.couldNotStartThisConversation')) }, { status: 500 });
    }
    const { data: conversation, error: readError } = await supabase.from('ai_conversations')
      .select('id').eq('id', conversationId).eq('family_id', familyId).eq('user_id', ctx.user.id).maybeSingle();
    if (readError) {
      console.error('[api/ai] conversation ownership read failed', readError);
      return NextResponse.json({ error: tr('ai.couldNotOpenThisConversation') }, { status: 503 });
    }
    if (!conversation) return NextResponse.json({ error: tr('ai.conversationNotFound') }, { status: 404 });

    const input: AssistantTurnInput = {
      supabase, familyId, userId: ctx.user.id, role: ctx.active.role,
      familyName: ctx.active.family.name, tz, conversationId, message,
    };
    const prepared = await prepareAssistantTurn(input);
    if (!prepared.ok) return NextResponse.json({ error: prepared.error }, { status: 500 });

    if (json) {
      const result = await runAssistantTurn(input, prepared.turn);
      return NextResponse.json({ conversationId, ...result });
    }
    return new Response(createAssistantStream(input, prepared.turn), { headers: SSE_HEADERS });
  } catch (err) {
    console.error('[api/ai] error:', err);
    return NextResponse.json({ error: describeAIError(err).message }, { status: 500 });
  }
}
