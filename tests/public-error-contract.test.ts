import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const publicMetricRoutes = [
  'app/api/ab/track/route.ts',
  'app/api/lp/track/route.ts',
  'app/api/exit-intent/track/route.ts',
];

describe('public metric error boundaries', () => {
  it('does not expose raw database errors to anonymous callers', () => {
    for (const route of publicMetricRoutes) {
      const source = readFileSync(route, 'utf8');
      expect(source).not.toMatch(/NextResponse\.json\(\{\s*error:\s*error\.message/);
      expect(source).toContain('console.error(');
    }
  });
});
