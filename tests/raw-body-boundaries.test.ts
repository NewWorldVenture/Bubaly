import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { readBoundedRequestText } from '@/lib/server/bounded-request-body';

const routeFiles = [
  'app/api/webhooks/stripe/route.ts',
  'app/api/webhooks/money/route.ts',
  'app/api/webhooks/resend/route.ts',
  'app/api/push/subscribe/route.ts',
  'app/api/push/unsubscribe/route.ts',
  'app/api/calendar/sync/route.ts',
];

describe('bounded raw request bodies', () => {
  it('preserves the exact raw text needed by signed webhook verification', async () => {
    const body = '{"event":"payment.succeeded","note":"caf\\u00e9"}';
    const request = new Request('https://example.test', { method: 'POST', body });

    await expect(readBoundedRequestText(request, 4096)).resolves.toEqual({ ok: true, text: body });
  });

  it('rejects chunked oversized input before buffering the complete body', async () => {
    let cancelled = false;
    const request = new Request('https://example.test', {
      method: 'POST',
      duplex: 'half',
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('x'.repeat(4097)));
        },
        cancel() {
          cancelled = true;
        },
      }),
    } as RequestInit & { duplex: 'half' });

    await expect(readBoundedRequestText(request, 4096)).resolves.toEqual({ ok: false, reason: 'too_large' });
    expect(cancelled).toBe(true);
  });

  it('keeps every audited raw-body route behind the shared reader', () => {
    for (const file of routeFiles) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).toContain('readBoundedRequestText');
      expect(source, file).not.toContain('await req.text()');
    }
  });
});
