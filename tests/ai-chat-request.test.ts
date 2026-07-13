import { describe, expect, it } from 'vitest';
import { MAX_AI_CHAT_MESSAGE_CHARS, parseAIChatRequest } from '@/lib/ai/chat-request';

const conversationId = '123e4567-e89b-12d3-a456-426614174000';

describe('agentic AI chat request contract', () => {
  it('normalizes a valid conversation and message', () => {
    expect(parseAIChatRequest({ conversationId: ` ${conversationId} `, message: '  Plan our week  ' })).toEqual({
      ok: true,
      value: { conversationId, message: 'Plan our week' },
    });
  });

  it('rejects malformed or missing conversation identifiers', () => {
    expect(parseAIChatRequest(null)).toEqual({ ok: false, error: 'invalid_body' });
    expect(parseAIChatRequest({ message: 'hello' })).toEqual({ ok: false, error: 'conversation_required' });
    expect(parseAIChatRequest({ conversationId: 'not-a-uuid', message: 'hello' })).toEqual({ ok: false, error: 'conversation_invalid' });
  });

  it('rejects blank and oversized messages', () => {
    expect(parseAIChatRequest({ conversationId, message: '   ' })).toEqual({ ok: false, error: 'message_required' });
    expect(parseAIChatRequest({ conversationId, message: 'x'.repeat(MAX_AI_CHAT_MESSAGE_CHARS + 1) })).toEqual({ ok: false, error: 'message_too_long' });
  });
});
