import { expectTranslates } from './helpers/translated';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { readBoundedRequestText } from '@/lib/server/bounded-request-body';

const route = readFileSync('app/api/sync/run/route.ts', 'utf8');

describe('provider sync request boundary', () => {
  it('reads a compact JSON body', async () => {
    const request = new Request('https://example.test/api/sync/run', {
      method: 'POST', body: JSON.stringify({ provider: 'google' }),
    });
    const result = await readBoundedRequestText(request, 4096);
    expect(result).toEqual({ ok: true, text: '{"provider":"google"}' });
  });

  it('stops reading once the byte budget is exceeded', async () => {
    const request = new Request('https://example.test/api/sync/run', {
      method: 'POST', body: 'x'.repeat(4097),
    });
    const result = await readBoundedRequestText(request, 4096);
    expect(result).toEqual({ ok: false, reason: 'too_large' });
  });

  it('keeps the route bounded and rejects untrusted provider shapes', () => {
    expect(route).toContain('MAX_SYNC_REQUEST_BYTES = 4_096');
    expect(route).toContain('readBoundedRequestText(req, MAX_SYNC_REQUEST_BYTES)');
    expect(route).toContain('typeof providerValue === \'string\'');
    expectTranslates(route, 'run.unsupportedSyncProvider', "Unsupported sync provider.");
    expect(route).not.toContain('req.json()');
  });
});
