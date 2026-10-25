import { config } from './config';
import { buildAssistantRequest, parseAssistantResponse, type AssistantReply } from './assistant-core';
import { ASSISTANT_DEADLINE_MS, withDeadline } from './deadline';
import { buildTranscribeRequest, parseTranscribeResponse, type Recording } from './voice-core';
import { mobileTranslate, type MobileTranslator } from './mobile-i18n';

export class AssistantError extends Error {
  constructor(message: string, readonly code?: string, readonly status?: number) {
    super(message);
    this.name = 'AssistantError';
  }
}

/**
 * One request with its body read, under the caller's signal AND a deadline
 * (deadline.ts): a stalled socket settles as "taking longer than expected"
 * with a retry instead of "Bubaly is thinking…" for ever, and a refused
 * connection as the network failure it is. The caller's own abort (Stop, a
 * context change) is rethrown as it is.
 */
async function send(url: string, init: RequestInit, signal: AbortSignal | undefined, t: MobileTranslator): Promise<{ status: number; body: unknown }> {
  const deadline = withDeadline(signal, ASSISTANT_DEADLINE_MS);
  try {
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: deadline.signal });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (deadline.timedOut()) throw new AssistantError(t('mobileAssistant.timedOut'), 'timeout');
      throw new AssistantError(t('mobileAssistant.network'), 'network');
    }
    let body: unknown = null;
    try { body = await res.json(); } catch { body = null; }
    return { status: res.status, body };
  } finally { deadline.clear(); }
}

/** One assistant turn over the JSON transport of /api/ai (bearer-authenticated). */
export async function askAssistant(args: { token: string; conversationId: string; message: string; expectedFamilyId?: string; locale?: string; signal?: AbortSignal }): Promise<AssistantReply> {
  const t: MobileTranslator = (key, params) => mobileTranslate(args.locale ?? 'en-US', key, params);
  const { url, init } = buildAssistantRequest({ apiUrl: config.apiUrl, ...args });
  const { status, body } = await send(url, init, args.signal, t);
  const parsed = parseAssistantResponse(status, body, t);
  if (!parsed.ok) throw new AssistantError(parsed.error, parsed.code, parsed.status);
  return parsed.reply;
}

/**
 * Send a recording to /api/ai/voice/transcribe with the caller's bearer token
 * and return what Bubaly heard. Throws `AssistantError` — including for the
 * honest 503 the route returns when no transcription key is configured — so the
 * screen can say what happened instead of dropping the recording silently.
 */
export async function transcribeSpeech(args: { token: string; recording: Recording; expectedFamilyId?: string; locale?: string; signal?: AbortSignal }): Promise<string> {
  const t: MobileTranslator = (key, params) => mobileTranslate(args.locale ?? 'en-US', key, params);
  const { url, init } = buildTranscribeRequest({ apiUrl: config.apiUrl, ...args });
  const { status, body } = await send(url, init, args.signal, t);
  const parsed = parseTranscribeResponse(status, body, t);
  if (!parsed.ok) throw new AssistantError(parsed.error, parsed.code, parsed.status);
  return parsed.text;
}
