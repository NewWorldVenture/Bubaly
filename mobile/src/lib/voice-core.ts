// Pure request/response logic for speaking to Bubaly from the phone
// (unit-tested from the repo root, like assistant-core.ts). The screen and
// api.ts only add the recorder and fetch on top.
//
// The phone posts the recording to the SAME endpoint the web mic uses —
// /api/ai/voice/transcribe — with `Authorization: Bearer <supabase jwt>`,
// which that route now accepts alongside the browser's cookie session.

import { englishMobile, type MobileTranslator } from './mobile-i18n';

/** A finished recording as expo-audio hands it over: a file:// uri plus its type. */
export type Recording = { uri: string; mimeType?: string; name?: string };

export type TranscribeFailure = { ok: false; error: string; code?: string; status: number };
export type TranscribeParse = { ok: true; text: string } | TranscribeFailure;

/** File extension → the mime type OpenAI's transcriber recognises. */
export function mimeForRecording(rec: Recording): string {
  if (rec.mimeType) return rec.mimeType;
  const ext = (rec.uri.split('?')[0].split('.').pop() ?? '').toLowerCase();
  switch (ext) {
    case 'm4a': case 'mp4': return 'audio/mp4';
    case 'mp3': return 'audio/mpeg';
    case 'wav': return 'audio/wav';
    case 'webm': return 'audio/webm';
    case 'caf': return 'audio/x-caf';
    case '3gp': return 'audio/3gpp';
    default: return 'audio/m4a';
  }
}

/** Upload filename; the server sniffs the extension, so it has to be real. */
export function filenameForRecording(rec: Recording): string {
  if (rec.name) return rec.name;
  const last = rec.uri.split('?')[0].split('/').pop() ?? '';
  return /\.[a-z0-9]{2,4}$/i.test(last) ? last : 'speech.m4a';
}

/**
 * The multipart part React Native's fetch understands: a file reference, not
 * bytes — which is why nothing here reads the recording into memory.
 */
export function transcribeFilePart(rec: Recording): { uri: string; name: string; type: string } {
  return { uri: rec.uri, name: filenameForRecording(rec), type: mimeForRecording(rec) };
}

/** The multipart request for one recording, addressed to the transcribe route. */
export function buildTranscribeRequest(args: { apiUrl: string; token: string; recording: Recording; expectedFamilyId?: string; locale?: string; signal?: AbortSignal }): { url: string; init: RequestInit } {
  const form = new FormData();
  form.append('audio', transcribeFilePart(args.recording) as unknown as Blob);
  return {
    url: `${args.apiUrl.replace(/\/+$/, '')}/api/ai/voice/transcribe`,
    init: {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${args.token}`,
        ...(args.expectedFamilyId !== undefined ? { 'X-Bubaly-Family-Id': args.expectedFamilyId } : {}),
        ...(args.locale ? { 'Accept-Language': args.locale } : {}),
        // Content-Type is deliberately absent: fetch adds the multipart
        // boundary, and setting it by hand corrupts the body.
      },
      body: form as unknown as BodyInit,
      ...(args.signal ? { signal: args.signal } : {}),
    },
  };
}

const FRIENDLY: Record<number, string> = {
  401: 'mobileAssistant.sessionExpired',
  403: 'mobileAssistant.needsFamily',
  413: 'mobileAssistant.recordingTooLong',
  422: 'mobileAssistant.noSpeech',
  429: 'mobileAssistant.rateLimited',
};

/**
 * Read the transcribe response. Failure is never dressed up as an empty
 * transcript. Configuration and an unavailable family read have distinct
 * codes even though both use 503; an unknown 503 retains its own error.
 */
export function parseTranscribeResponse(status: number, body: unknown, t: MobileTranslator = englishMobile): TranscribeParse {
  const obj = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (status >= 200 && status < 300) {
    const text = typeof obj.text === 'string' ? obj.text.replace(/\s+/g, ' ').trim() : '';
    if (text) return { ok: true, text };
    return { ok: false, error: t('mobileAssistant.noSpeech'), code: 'no_speech', status };
  }
  const serverError = typeof obj.error === 'string' && obj.error.trim() ? obj.error.trim() : null;
  const code = typeof obj.code === 'string' ? obj.code : undefined;
  const key = code === 'not_configured' ? 'mobileAssistant.voiceNotConfigured'
    : code === 'unavailable' ? 'mobileAssistant.familyUnavailable'
      : code === 'family_changed' || code === 'invalid_family' ? 'mobileAssistant.contextChanged' : FRIENDLY[status];
  return {
    ok: false,
    error: key ? t(key) : serverError ?? t('mobileAssistant.transcribeFailed'),
    code,
    status,
  };
}
