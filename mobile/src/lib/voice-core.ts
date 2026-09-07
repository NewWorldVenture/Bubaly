// Pure request/response logic for speaking to Bubaly from the phone
// (unit-tested from the repo root, like assistant-core.ts). The screen and
// api.ts only add the recorder and fetch on top.
//
// The phone posts the recording to the SAME endpoint the web mic uses —
// /api/ai/voice/transcribe — with `Authorization: Bearer <supabase jwt>`,
// which that route now accepts alongside the browser's cookie session.

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
 * The multipart request for one recording. React Native's fetch accepts a
 * `{ uri, name, type }` part in FormData and streams the file itself, which is
 * why nothing here reads the file into memory.
 */
export function buildTranscribeRequest(args: { apiUrl: string; token: string; recording: Recording }): { url: string; init: RequestInit } {
  const form = new FormData();
  form.append('audio', {
    uri: args.recording.uri,
    name: filenameForRecording(args.recording),
    type: mimeForRecording(args.recording),
  } as unknown as Blob);
  return {
    url: `${args.apiUrl.replace(/\/+$/, '')}/api/ai/voice/transcribe`,
    init: {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${args.token}`,
        // Content-Type is deliberately absent: fetch adds the multipart
        // boundary, and setting it by hand corrupts the body.
      },
      body: form as unknown as BodyInit,
    },
  };
}

const FRIENDLY: Record<number, string> = {
  401: 'Your session expired. Sign in again to talk to Bubaly.',
  403: 'Finish setting up your family on the web app first.',
  413: 'That recording is too long. Try a shorter one.',
  422: 'Bubaly didn’t catch that. Try again.',
  429: 'Too many voice requests just now. Try again in a moment.',
  503: 'Voice isn’t switched on for this workspace yet — type your request instead.',
};

/**
 * Read the transcribe response. Failure is never dressed up as an empty
 * transcript: a 503 says voice is not configured, and the caller shows that
 * rather than a silent no-op.
 */
export function parseTranscribeResponse(status: number, body: unknown): TranscribeParse {
  const obj = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (status >= 200 && status < 300) {
    const text = typeof obj.text === 'string' ? obj.text.replace(/\s+/g, ' ').trim() : '';
    if (text) return { ok: true, text };
    return { ok: false, error: 'Bubaly didn’t catch that. Try again.', code: 'no_speech', status };
  }
  const serverError = typeof obj.error === 'string' && obj.error.trim() ? obj.error.trim() : null;
  return {
    ok: false,
    error: FRIENDLY[status] ?? serverError ?? 'Bubaly couldn’t transcribe that. Try again.',
    code: typeof obj.code === 'string' ? obj.code : undefined,
    status,
  };
}
