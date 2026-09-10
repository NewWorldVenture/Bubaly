import { describe, expect, it } from 'vitest';
import {
  buildTranscribeRequest, filenameForRecording, mimeForRecording, parseTranscribeResponse, transcribeFilePart,
} from '../mobile/src/lib/voice-core';

// M19 — the phone can talk to Bubaly. The Expo screen owns the recorder; this
// is the part that has to be right regardless of the device: the request it
// posts (bearer token, real filename, multipart) and how each answer is read.

describe('buildTranscribeRequest', () => {
  it('posts the recording to the shared transcribe route with the bearer token', () => {
    const { url, init } = buildTranscribeRequest({
      apiUrl: 'https://www.bubaly.com/',
      token: 'jwt-123',
      recording: { uri: 'file:///tmp/rec/AV-1.m4a' },
    });
    expect(url).toBe('https://www.bubaly.com/api/ai/voice/transcribe');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer jwt-123');
    // Setting Content-Type by hand would drop the multipart boundary.
    expect(Object.keys(init.headers as Record<string, string>)).not.toContain('Content-Type');
    expect(init.body).toBeInstanceOf(FormData);
  });

  it('sends a file reference with a name and type the server can sniff', () => {
    expect(transcribeFilePart({ uri: 'file:///tmp/rec/AV-1.m4a' })).toEqual({
      uri: 'file:///tmp/rec/AV-1.m4a', name: 'AV-1.m4a', type: 'audio/mp4',
    });
  });
});

describe('naming a recording', () => {
  it('maps the extension expo-audio produces to a mime type OpenAI accepts', () => {
    expect(mimeForRecording({ uri: 'file:///a/b.m4a' })).toBe('audio/mp4');
    expect(mimeForRecording({ uri: 'file:///a/b.3gp' })).toBe('audio/3gpp');
    expect(mimeForRecording({ uri: 'file:///a/b.wav' })).toBe('audio/wav');
    expect(mimeForRecording({ uri: 'file:///a/b.weird' })).toBe('audio/m4a');
    expect(mimeForRecording({ uri: 'file:///a/b.m4a', mimeType: 'audio/webm' })).toBe('audio/webm');
  });

  it('always produces a filename with an extension', () => {
    expect(filenameForRecording({ uri: 'file:///a/recording.m4a' })).toBe('recording.m4a');
    expect(filenameForRecording({ uri: 'file:///a/no-extension' })).toBe('speech.m4a');
    expect(filenameForRecording({ uri: 'file:///a/x.m4a', name: 'custom.mp4' })).toBe('custom.mp4');
  });
});

describe('parseTranscribeResponse', () => {
  it('returns the tidied transcript on success', () => {
    expect(parseTranscribeResponse(200, { text: '  Plan   dinners  ' })).toEqual({ ok: true, text: 'Plan dinners' });
  });

  it('treats an empty transcript as "did not catch that", never as success', () => {
    const parsed = parseTranscribeResponse(200, { text: '   ' });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.code).toBe('no_speech');
  });

  it('says voice is not configured on the honest 503 rather than failing silently', () => {
    const parsed = parseTranscribeResponse(503, { error: 'Voice isn’t configured', code: 'not_configured' });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.status).toBe(503);
      expect(parsed.error).toMatch(/isn’t switched on/i);
    }
  });

  it('asks the person to sign in again on 401 and to finish setup on 403', () => {
    const unauthorized = parseTranscribeResponse(401, { code: 'invalid_token' });
    expect(unauthorized.ok).toBe(false);
    if (!unauthorized.ok) {
      expect(unauthorized.error).toMatch(/sign in again/i);
      expect(unauthorized.code).toBe('invalid_token');
    }
    const forbidden = parseTranscribeResponse(403, { code: 'needs_family' });
    if (!forbidden.ok) expect(forbidden.error).toMatch(/family/i);
  });

  it('falls back to the server’s own message for an unmapped failure', () => {
    const parsed = parseTranscribeResponse(400, { error: 'Not an audio file' });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toBe('Not an audio file');
  });

  it('never throws on a body that is not an object', () => {
    for (const body of [null, undefined, 'nope', 42, []]) {
      expect(() => parseTranscribeResponse(200, body)).not.toThrow();
      expect(parseTranscribeResponse(200, body).ok).toBe(false);
    }
  });
});
