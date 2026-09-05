import { config } from './config';
import { buildAssistantRequest, parseAssistantResponse, type AssistantReply } from './assistant-core';

export class AssistantError extends Error {
  constructor(message: string, readonly code?: string, readonly status?: number) {
    super(message);
    this.name = 'AssistantError';
  }
}

/** One assistant turn over the JSON transport of /api/ai (bearer-authenticated). */
export async function askAssistant(args: { token: string; conversationId: string; message: string }): Promise<AssistantReply> {
  const { url, init } = buildAssistantRequest({ apiUrl: config.apiUrl, ...args });
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new AssistantError('Can’t reach Bubaly. Check your connection and try again.', 'network');
  }
  let body: unknown = null;
  try { body = await res.json(); } catch { body = null; }
  const parsed = parseAssistantResponse(res.status, body);
  if (!parsed.ok) throw new AssistantError(parsed.error, parsed.code, parsed.status);
  return parsed.reply;
}
