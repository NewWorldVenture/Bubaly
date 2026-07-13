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
