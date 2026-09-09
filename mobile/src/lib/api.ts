import { config } from './config';
import { buildAssistantRequest, parseAssistantResponse, type AssistantReply } from './assistant-core';
import { buildTranscribeRequest, parseTranscribeResponse, type Recording } from './voice-core';
import { mobileTranslate } from './mobile-i18n';

export class AssistantError extends Error {
  constructor(message: string, readonly code?: string, readonly status?: number) {
    super(message);
    this.name = 'AssistantError';
  }
}

/** One assistant turn over the JSON transport of /api/ai (bearer-authenticated). */
export async function askAssistant(args: { token: string; conversationId: string; message: string; expectedFamilyId?: string; locale?: string; signal?: AbortSignal }): Promise<AssistantReply> {
  const t = (key: string) => mobileTranslate(args.locale ?? 'en-US', key);
  const { url, init } = buildAssistantRequest({ apiUrl: config.apiUrl, ...args });
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (error) {
    if (args.signal?.aborted) throw error;
    throw new AssistantError(t('mobileAssistant.network'), 'network');
  }
  let body: unknown = null;
  try { body = await res.json(); } catch { body = null; }
  const parsed = parseAssistantResponse(res.status, body, t);
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
  const t = (key: string) => mobileTranslate(args.locale ?? 'en-US', key);
  const { url, init } = buildTranscribeRequest({ apiUrl: config.apiUrl, ...args });
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (error) {
    if (args.signal?.aborted) throw error;
    throw new AssistantError(t('mobileAssistant.network'), 'network');
  }
  let body: unknown = null;
  try { body = await res.json(); } catch { body = null; }
  const parsed = parseTranscribeResponse(res.status, body, t);
  if (!parsed.ok) throw new AssistantError(parsed.error, parsed.code, parsed.status);
  return parsed.text;
}
