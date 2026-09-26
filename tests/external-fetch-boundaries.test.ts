import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fetchWithTimeout } from '@/lib/client-fetch';
import { fetchExternal } from '@/lib/server/external-fetch';

const serverFiles = [
  'lib/ai/provider.ts',
  'lib/google.ts',
  'lib/guardian/ai-screen.ts',
  'lib/guardian/scam-ai.ts',
  'lib/guardian/twilio.ts',
  'lib/marketing/send.ts',
  'lib/server/email.ts',
  'lib/server/native-push.ts',
  'lib/sync/providers/google.ts',
  'lib/sync/providers/microsoft.ts',
  'lib/vacations/weather-fetch.ts',
  'app/api/ai/flyer/route.ts',
  'app/api/ai/voice/speak/route.ts',
  'app/api/ai/voice/transcribe/route.ts',
  'app/api/gif/search/route.ts',
];

afterEach(() => vi.restoreAllMocks());

describe('external fetch deadlines', () => {
  it('adds a timeout signal to fixed-provider server calls', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);

    await fetchExternal('https://provider.example.test', undefined, 1000);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal?.aborted).toBe(false);
  });

  it('adds and clears the browser-side timeout signal', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);

    await fetchWithTimeout('https://provider.example.test', undefined, 1000);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal?.aborted).toBe(false);
  });

  it('keeps audited fixed-provider files behind an explicit timeout wrapper', () => {
    for (const file of serverFiles) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).toContain('fetchExternal');
      expect(source, file).not.toMatch(/await fetch\(/);
    }
  });

  // `lib/server/push.ts` was on the list above and came off it, because it no
  // longer reaches a provider: its native send targeted the FCM legacy endpoint
  // Google decommissioned on 2024-06-20, and the web half goes out through the
  // `web-push` library rather than fetch. The half of the rule that still bites
  // is kept here rather than dropped with the entry — "no bare fetch" is true of
  // every server file whether or not it currently calls one.
  it('files that left the audited list still may not reach for a bare fetch', () => {
    for (const file of ['lib/server/push.ts']) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).not.toMatch(/await fetch\(/);
      expect(source, file).not.toMatch(/fetch\(['"`]https?:/);
    }
  });

  it('keeps browser public-provider helpers behind a timeout wrapper', () => {
    for (const file of ['lib/weather/open-meteo.ts', 'lib/trips/routing.ts']) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).toContain('fetchWithTimeout');
      expect(source, file).not.toMatch(/await fetch\(/);
    }
  });
});
