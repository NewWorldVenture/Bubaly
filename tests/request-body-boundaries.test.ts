import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { readBoundedRequestJson, readBoundedRequestJsonOrEmpty } from '@/lib/server/bounded-request-body';

const routeFiles = [
  'app/api/billing/checkout/route.ts',
  'app/api/billing/change-plan/route.ts',
  'app/api/billing/cancel/route.ts',
  'app/api/contact/route.ts',
  'app/api/forms/submit/route.ts',
  'app/api/mkt/track/route.ts',
  'app/api/ab/track/route.ts',
  'app/api/exit-intent/track/route.ts',
  'app/api/lp/track/route.ts',
  'app/api/email/invite/route.ts',
  'app/api/email/welcome/route.ts',
];

describe('bounded JSON request bodies', () => {
  it('parses compact JSON', async () => {
    const request = new Request('https://example.test', {
      method: 'POST',
      body: JSON.stringify({ plan: 'family' }),
    });
    await expect(readBoundedRequestJson(request, 4096)).resolves.toEqual({
      ok: true,
      value: { plan: 'family' },
    });
  });

  it('rejects invalid JSON and stops oversized bodies before parsing', async () => {
    const invalid = new Request('https://example.test', { method: 'POST', body: '{' });
    await expect(readBoundedRequestJson(invalid, 4096)).resolves.toEqual({ ok: false, reason: 'invalid_json' });

    const oversized = new Request('https://example.test', { method: 'POST', body: 'x'.repeat(4097) });
    await expect(readBoundedRequestJson(oversized, 4096)).resolves.toEqual({ ok: false, reason: 'too_large' });
  });

  it('keeps every audited route behind the shared reader', () => {
    for (const file of routeFiles) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).toContain('readBoundedRequestJson');
      expect(source, file).not.toContain('req.json()');
    }
  });

  it('preserves optional empty-body behavior without allowing oversized input', async () => {
    const empty = new Request('https://example.test', { method: 'POST' });
    await expect(readBoundedRequestJsonOrEmpty(empty, 4096)).resolves.toEqual({ ok: true, value: {} });

    const oversized = new Request('https://example.test', { method: 'POST', body: 'x'.repeat(4097) });
    await expect(readBoundedRequestJsonOrEmpty(oversized, 4096)).resolves.toEqual({ ok: false, reason: 'too_large' });
  });
});
