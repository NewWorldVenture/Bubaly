import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { readBoundedResponseJson, readBoundedResponseText } from '@/lib/server/bounded-response-body';

const textFiles = [
  'lib/ai/provider.ts',
  'lib/guardian/twilio.ts',
  'lib/server/email.ts',
  'lib/marketing/send.ts',
  'lib/sync/providers/google.ts',
  'lib/sync/providers/microsoft.ts',
  'app/api/ai/flyer/route.ts',
  'app/api/ai/voice/transcribe/route.ts',
  'app/api/ai/voice/speak/route.ts',
];

const jsonFiles = [
  'lib/ai/provider.ts',
  'lib/weather/open-meteo.ts',
  'lib/trips/routing.ts',
  'app/api/weekend/discover/route.ts',
  'lib/vacations/weather-fetch.ts',
  'lib/guardian/twilio.ts',
  'lib/sync/providers/google.ts',
  'lib/sync/providers/microsoft.ts',
  'lib/recipes/providers/themealdb.ts',
  'lib/guardian/scam-ai.ts',
  'lib/guardian/ai-screen.ts',
  'app/api/ai/flyer/route.ts',
  'app/api/ai/voice/transcribe/route.ts',
  'lib/google.ts',
  'app/api/gif/search/route.ts',
];

describe('bounded external response bodies', () => {
  it('reads a compact provider response exactly', async () => {
    const response = new Response('{"error":"invalid_api_key"}', { status: 401 });
    await expect(readBoundedResponseText(response, 4096)).resolves.toEqual({
      ok: true,
      text: '{"error":"invalid_api_key"}',
    });
  });

  it('cancels a streamed response as soon as it exceeds the limit', async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('x'.repeat(4097)));
      },
      cancel() {
        cancelled = true;
      },
    }));

    await expect(readBoundedResponseText(response, 4096)).resolves.toEqual({ ok: false, reason: 'too_large' });
    expect(cancelled).toBe(true);
  });

  it('parses compact JSON through the same bounded reader', async () => {
    const response = new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
    await expect(readBoundedResponseJson<{ ok: boolean }>(response, 4096)).resolves.toEqual({ ok: true });
  });

  it('rejects invalid JSON after applying the byte bound', async () => {
    await expect(readBoundedResponseJson(new Response('not-json'), 4096)).rejects.toThrow(/invalid JSON/i);
  });

  it('keeps audited provider error paths behind the shared reader', () => {
    for (const file of textFiles) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).toContain('readBoundedResponseText');
      expect(source, file).not.toContain('await res.text()');
      expect(source, file).not.toContain('await aiRes.text()');
    }
  });

  it('keeps audited provider JSON paths behind the shared reader', () => {
    for (const file of jsonFiles) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).toContain('readBoundedResponseJson');
      expect(source, file).not.toMatch(/await (?:res|aiRes)\.json\(\)/);
    }
  });
});
