import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../mobile/src/lib/config', () => ({ config: { apiUrl: 'https://www.bubaly.com' } }));
import { mobileTranslate } from '../mobile/src/lib/mobile-i18n';

// Native config is mocked at runtime. Keep this import dynamic so the separate
// web typecheck does not require Expo packages installed only by the mobile job.
const apiModule = '../mobile/src/lib/api';
const { askAssistant, transcribeSpeech } = await import(apiModule);

afterEach(() => vi.unstubAllGlobals());
const base = { token: 'token', expectedFamilyId: 'family-1', locale: 'fr-FR' };
const ask = (signal?: AbortSignal) => askAssistant({ ...base, conversationId: 'conversation-1', message: 'Bonjour', signal });
const transcribe = (signal?: AbortSignal) => transcribeSpeech({ ...base, recording: { uri: 'file:///voice.m4a' }, signal });

describe('mobile API fetch integration', () => {
  it('carries context to real request builders and parses both successful transports', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ text: ' Bonjour ' }))
      .mockResolvedValueOnce(Response.json({ content: 'Bonjour', conversationId: 'conversation-1', persisted: false }));
    vi.stubGlobal('fetch', fetch);
    expect(await transcribe()).toBe('Bonjour'); expect(await ask()).toMatchObject({ content: 'Bonjour', persisted: false });
    for (const call of fetch.mock.calls) expect(call[1].headers).toMatchObject({ Authorization: 'Bearer token', 'Accept-Language': 'fr-FR', 'X-Bubaly-Family-Id': 'family-1' });
    expect(fetch.mock.calls[0][1].body).toBeInstanceOf(FormData);
  });

  it.each([['assistant', ask], ['transcribe', transcribe]] as const)('%s preserves abort errors instead of displaying a network failure', async (_name, operation) => {
    const controller = new AbortController(); const abort = new Error('aborted'); controller.abort();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abort));
    await expect(operation(controller.signal)).rejects.toBe(abort);
  });

  it.each([['assistant', ask], ['transcribe', transcribe]] as const)('%s translates a transport failure for the selected locale', async (_name, operation) => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('native fetch failed')));
    await expect(operation()).rejects.toMatchObject({ code: 'network', message: mobileTranslate('fr-FR', 'mobileAssistant.network') });
  });

  it('keeps context-unavailable and missing voice configuration distinct all the way to the screen error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ code: 'unavailable' }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ code: 'not_configured' }, { status: 503 })));
    await expect(transcribe()).rejects.toMatchObject({ code: 'unavailable', message: mobileTranslate('fr-FR', 'mobileAssistant.familyUnavailable') });
    await expect(transcribe()).rejects.toMatchObject({ code: 'not_configured', message: mobileTranslate('fr-FR', 'mobileAssistant.voiceNotConfigured') });
  });
});
