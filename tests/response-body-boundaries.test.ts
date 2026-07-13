import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { readBoundedResponseText } from '@/lib/server/bounded-response-body';

const providerFiles = [
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

  it('keeps audited provider error paths behind the shared reader', () => {
    for (const file of providerFiles) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).toContain('readBoundedResponseText');
      expect(source, file).not.toContain('await res.text()');
      expect(source, file).not.toContain('await aiRes.text()');
    }
  });
});
