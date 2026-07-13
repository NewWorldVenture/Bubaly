import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const routes = [
  'app/api/contact/route.ts',
  'app/api/forms/submit/route.ts',
  'app/api/exit-intent/track/route.ts',
  'app/api/lp/track/route.ts',
  'app/api/mkt/track/route.ts',
  'app/api/ab/track/route.ts',
  'app/api/marketing/unsubscribe/route.ts',
];

describe('public service-role side-effect limits', () => {
  it('uses the shared durable guard on every public ingestion route', () => {
    for (const route of routes) {
      const source = readFileSync(resolve(process.cwd(), route), 'utf8');
      expect(source, route).toContain("from '@/lib/server/request-rate-limit'");
      expect(source, route).toContain('await enforceRequestRateLimit(');
      expect(source, route).toContain("'Retry-After'");
    }
  });

  it('does not leave the older local-only limiter import on these routes', () => {
    for (const route of routes) {
      const source = readFileSync(resolve(process.cwd(), route), 'utf8');
      expect(source, route).not.toContain("import { rateLimit, clientIp } from '@/lib/server/rate-limit'");
    }
  });
});
