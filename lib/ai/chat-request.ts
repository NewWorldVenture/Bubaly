const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const MAX_AI_CHAT_MESSAGE_CHARS = 8_000;

export type AIChatRequest = {
  conversationId: string;
  message: string;
};

export type AIChatRequestParse =
  | { ok: true; value: AIChatRequest }
  | { ok: false; error: 'invalid_body' | 'conversation_required' | 'conversation_invalid' | 'message_required' | 'message_too_long' };

/** Validate and normalize the bounded input accepted by the agentic chat route. */
export function parseAIChatRequest(value: unknown): AIChatRequestParse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'invalid_body' };

  const body = value as Record<string, unknown>;
  const conversationId = typeof body.conversationId === 'string' ? body.conversationId.trim() : '';
  if (!conversationId) return { ok: false, error: 'conversation_required' };
  if (!UUID_PATTERN.test(conversationId)) return { ok: false, error: 'conversation_invalid' };

  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) return { ok: false, error: 'message_required' };
  if (message.length > MAX_AI_CHAT_MESSAGE_CHARS) return { ok: false, error: 'message_too_long' };

  return { ok: true, value: { conversationId, message } };
}

// ─── Request intake (POST /api/ai/requests) ─────────────────────────────────
//
// The contract the Ask Bubaly entry points speak. Kept next to the chat parser
// because both are the client-facing edge of the same AI layer, and because
// this module has no server-only imports: the browser components call
// `submitAIRequest` and the route calls `parseAIRequestIntake`, so the two
// sides can never disagree about a field name.

export const MAX_AI_REQUEST_TEXT_CHARS = 4_000;
/** A clarification answer is a short reply, never a second request. */
export const MAX_AI_ANSWER_CHARS = 1_000;
const MAX_ANSWER_ENTRIES = 12;
const MAX_ENTITY_IDS = 20;
const MAX_MODULE_CHARS = 60;

export type AIRequestContext = { module?: string; entityIds?: string[] };

/**
 * A client-supplied id for one submission: a UUID, a ULID, `<device>:<n>`…
 * Bounded and character-limited because it is stored verbatim and indexed
 * per family; anything else is a 400, never silently dropped (a dropped key
 * would turn a retry back into a second request).
 */
export const CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;

export function isClientRequestId(value: unknown): value is string {
  return typeof value === 'string' && CLIENT_REQUEST_ID_PATTERN.test(value);
}

export type AIRequestIntake = {
  text: string;
  conversationId: string | null;
  context: AIRequestContext | null;
  answers: Record<string, string> | null;
  /** The submission's idempotency key, when the client sent one. */
  clientRequestId: string | null;
};

export type AIRequestIntakeParse =
  | { ok: true; value: AIRequestIntake }
  | { ok: false; error: 'invalid_body' | 'text_required' | 'text_too_long' | 'conversation_invalid' | 'client_request_id_invalid' };

export type AIRequestIntakeParseOptions = {
  /** The `Idempotency-Key` request header; it wins over a `clientRequestId` in the body. */
  idempotencyKey?: string | null;
};

/** Validate and normalize the body of `POST /api/ai/requests`. */
export function parseAIRequestIntake(value: unknown, opts: AIRequestIntakeParseOptions = {}): AIRequestIntakeParse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'invalid_body' };
  const body = value as Record<string, unknown>;

  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) return { ok: false, error: 'text_required' };
  if (text.length > MAX_AI_REQUEST_TEXT_CHARS) return { ok: false, error: 'text_too_long' };

  let clientRequestId: string | null = null;
  const rawKey = typeof opts.idempotencyKey === 'string' && opts.idempotencyKey.trim() ? opts.idempotencyKey : body.clientRequestId;
  if (rawKey !== undefined && rawKey !== null) {
    const key = typeof rawKey === 'string' ? rawKey.trim() : '';
    if (!isClientRequestId(key)) return { ok: false, error: 'client_request_id_invalid' };
    clientRequestId = key;
  }

  let conversationId: string | null = null;
  if (body.conversationId !== undefined && body.conversationId !== null) {
    const raw = typeof body.conversationId === 'string' ? body.conversationId.trim() : '';
    if (!raw || !UUID_PATTERN.test(raw)) return { ok: false, error: 'conversation_invalid' };
    conversationId = raw;
  }

  let context: AIRequestContext | null = null;
  if (body.context && typeof body.context === 'object' && !Array.isArray(body.context)) {
    const raw = body.context as Record<string, unknown>;
    const moduleName = typeof raw.module === 'string' ? raw.module.trim().slice(0, MAX_MODULE_CHARS) : '';
    const entityIds = Array.isArray(raw.entityIds)
      ? raw.entityIds.filter((id): id is string => typeof id === 'string' && UUID_PATTERN.test(id)).slice(0, MAX_ENTITY_IDS)
      : [];
    if (moduleName || entityIds.length) context = { ...(moduleName ? { module: moduleName } : {}), ...(entityIds.length ? { entityIds } : {}) };
  }

  let answers: Record<string, string> | null = null;
  if (body.answers && typeof body.answers === 'object' && !Array.isArray(body.answers)) {
    const clean: Record<string, string> = {};
    for (const [key, val] of Object.entries(body.answers as Record<string, unknown>).slice(0, MAX_ANSWER_ENTRIES)) {
      const k = key.trim().slice(0, 200);
      if (k && typeof val === 'string' && val.trim()) clean[k] = val.trim().slice(0, MAX_AI_ANSWER_CHARS);
    }
    if (Object.keys(clean).length) answers = clean;
  }

  return { ok: true, value: { text, conversationId, context, answers, clientRequestId } };
}

export type AIRequestOutcomeKind = 'plan' | 'recommendation' | 'clarification' | 'answer';

/** The 202 body of `POST /api/ai/requests` and of the `answer` control. */
export type AIRequestResponse = {
  requestId: string;
  runId: string | null;
  planId: string | null;
  outcome: AIRequestOutcomeKind;
  /** User-facing: the plan's summary, the answer text, or the clarifying question. */
  summary: string;
  redirect: string | null;
  /** Present when `outcome` is 'clarification'. */
  question?: string;
};

export type AIRequestSubmitResult =
  | { ok: true; data: AIRequestResponse }
  | { ok: false; status: number; error: string; code?: string; retryAfter?: number };

/** The run detail page for a run id — the one place this path is spelled out for the client. */
export function runPagePath(runId: string): string {
  return `/dashboard/concierge/runs/${encodeURIComponent(runId)}`;
}

async function readResult(res: Response): Promise<AIRequestSubmitResult> {
  let body: unknown = null;
  try { body = await res.json(); } catch { body = null; }
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  if (res.ok) return { ok: true, data: record as unknown as AIRequestResponse };
  const retryAfter = Number(res.headers.get('retry-after') ?? '');
  return {
    ok: false,
    status: res.status,
    error: typeof record.error === 'string' && record.error ? record.error : 'Bubaly could not take that request right now.',
    ...(typeof record.code === 'string' ? { code: record.code } : {}),
    ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfter } : {}),
  };
}

/**
 * File a request from the browser. Never throws: a network failure is a
 * result the caller renders, the same as a 4xx from the route.
 *
 * `clientRequestId` is optional but worth sending from any caller that
 * retries: the route answers a retry with the request it already filed
 * instead of planning (and executing) it a second time.
 */
export async function submitAIRequest(
  input: { text: string; conversationId?: string | null; context?: AIRequestContext | null; answers?: Record<string, string> | null; clientRequestId?: string | null },
  fetchImpl: typeof fetch = fetch,
): Promise<AIRequestSubmitResult> {
  try {
    const res = await fetchImpl('/api/ai/requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(input.clientRequestId ? { 'idempotency-key': input.clientRequestId } : {}) },
      body: JSON.stringify({
        text: input.text,
        ...(input.conversationId ? { conversationId: input.conversationId } : {}),
        ...(input.context ? { context: input.context } : {}),
        ...(input.answers ? { answers: input.answers } : {}),
        ...(input.clientRequestId ? { clientRequestId: input.clientRequestId } : {}),
      }),
    });
    return await readResult(res);
  } catch (error) {
    console.error('[ai/requests] submit failed', error);
    return { ok: false, status: 0, error: 'You appear to be offline. Try again when you are connected.' };
  }
}

/** Answer the clarifying question a run is waiting on; the run then continues. */
export async function answerAIRequest(
  runId: string,
  answer: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AIRequestSubmitResult> {
  try {
    const res = await fetchImpl(`/api/ai/runs/${encodeURIComponent(runId)}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answer }),
    });
    return await readResult(res);
  } catch (error) {
    console.error('[ai/requests] answer failed', error);
    return { ok: false, status: 0, error: 'You appear to be offline. Try again when you are connected.' };
  }
}
