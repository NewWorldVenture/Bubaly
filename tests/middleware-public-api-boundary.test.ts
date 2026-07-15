import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const middleware = readFileSync('middleware.ts', 'utf8');

describe('middleware public API boundary', () => {
  it('keeps anonymous product surfaces reachable before route-level guards run', () => {
    for (const path of [
      '/api/contact', '/api/blog', '/api/ab', '/api/mkt',
      '/api/services/descriptions', '/api/ai/gift',
    ]) {
      expect(middleware, path).toContain(`'${path}'`);
    }
  });

  it('lets scheduled and signed provider callbacks reach their own authorization checks', () => {
    for (const path of ['/api/cron', '/api/concierge-calls', '/api/guardian', '/api/email/welcome', '/api/webhooks']) {
      expect(middleware, path).toContain(`'${path}'`);
    }
  });

  it('keeps the route-level boundary explicit in the source', () => {
    expect(middleware).toContain('rate-limit');
    expect(middleware).toContain('Provider webhooks');
  });
});
