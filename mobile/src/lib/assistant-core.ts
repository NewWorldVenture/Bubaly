// Pure request/response logic for the /api/ai JSON transport (unit-tested from
// the repo root). The screen + api.ts only add fetch and state on top.

export type AssistantAction = { name: string; ok: boolean; summary: string };
export type AssistantReply = {
  conversationId: string;
  content: string;
  actions: AssistantAction[];
  persisted: boolean;
  model?: string;
};

export type AssistantFailure = { ok: false; error: string; code?: string; status: number };
export type AssistantParse = { ok: true; reply: AssistantReply } | AssistantFailure;

export function buildAssistantRequest(args: { apiUrl: string; token: string; conversationId: string; message: string }): { url: string; init: RequestInit } {
  return {
    url: `${args.apiUrl.replace(/\/+$/, '')}/api/ai?mode=json`,
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${args.token}`,
      },
      body: JSON.stringify({ conversationId: args.conversationId, message: args.message, stream: false }),
    },
  };
}

const FRIENDLY: Record<string, string> = {
  invalid_token: 'Your session expired. Sign in again to keep chatting.',
  signed_out: 'Sign in to use the assistant.',
  needs_family: 'Finish setting up your family on the web app first.',
  not_configured: 'The assistant isn’t switched on for this workspace yet.',
  message_too_long: 'That message is a little long — try a shorter one.',
};

export function parseAssistantResponse(status: number, body: unknown): AssistantParse {
  const obj = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (status >= 200 && status < 300 && typeof obj.content === 'string') {
    const actions = Array.isArray(obj.actions)
      ? obj.actions
          .filter((a): a is Record<string, unknown> => Boolean(a) && typeof a === 'object')
          .map((a) => ({ name: String(a.name ?? ''), ok: a.ok !== false, summary: String(a.summary ?? '') }))
      : [];
    return {
      ok: true,
      reply: {
        conversationId: String(obj.conversationId ?? ''),
        content: obj.content,
        actions,
        persisted: obj.persisted !== false,
        ...(typeof obj.model === 'string' ? { model: obj.model } : {}),
      },
    };
  }
  const code = typeof obj.code === 'string' ? obj.code : undefined;
  const serverError = typeof obj.error === 'string' ? obj.error : undefined;
  if (status === 429) return { ok: false, status, code: 'rate_limited', error: 'You’re sending messages quickly — give it a moment.' };
  const error = (code && FRIENDLY[code]) ?? serverError ?? (status >= 500 ? 'Bubaly hit a snag. Try again in a moment.' : 'Something went wrong.');
  return { ok: false, status, error, ...(code ? { code } : {}) };
}
