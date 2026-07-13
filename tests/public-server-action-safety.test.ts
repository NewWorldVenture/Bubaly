import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const actions = [
  'app/reviews/new/actions.ts',
  'app/s/[slug]/actions.ts',
  'app/gift/actions.ts',
];

describe('public service-role server actions', () => {
  it('use the shared durable limiter before public writes', () => {
    for (const path of actions) {
      const source = readFileSync(resolve(process.cwd(), path), 'utf8');
      expect(source, path).toContain("from '@/lib/server/request-rate-limit'");
      expect(source, path).toContain('await enforceRequestRateLimit(');
      expect(source, path).toContain("from '@/lib/server/rate-limit'");
      expect(source, path).toContain('clientIp(await headers())');
      expect(source, path).toContain('createServiceClient()');
    }
  });

  it('does not call trim on untrusted non-string fields', () => {
    for (const path of actions) {
      const source = readFileSync(resolve(process.cwd(), path), 'utf8');
      expect(source, path).not.toMatch(/input\.[A-Za-z]+\?\.trim/);
      expect(source, path).toContain("typeof payload");
    }
  });
});
