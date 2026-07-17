import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { hasCronAuthorization, hasInternalSecret } from '@/lib/server/cron-auth';

// Enumerate EVERY scheduled route from disk instead of a hand-maintained list —
// a hardcoded list silently drifts (it once missed feedback-github-sync +
// return-reminders), which would let a new ungated, publicly-reachable cron route
// slip past this guard. Globbing means any cron route added later is covered
// automatically. `concierge-calls/place` shares the same CRON_SECRET boundary.
const cronRoutes = [
  ...readdirSync('app/api/cron', { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => `app/api/cron/${e.name}/route.ts`),
  'app/api/concierge-calls/place/route.ts',
];

afterEach(() => vi.unstubAllEnvs());

describe('scheduled callback authorization', () => {
  it('fails closed when the deployment secret is missing', () => {
    vi.stubEnv('CRON_SECRET', '');
    const request = new Request('https://example.test', { headers: { authorization: 'Bearer undefined' } });
    expect(hasCronAuthorization(request)).toBe(false);
  });

  it('accepts only the configured cron secret', () => {
    const valid = new Request('https://example.test', { headers: { authorization: 'Bearer cron-secret' } });
    const invalid = new Request('https://example.test', { headers: { authorization: 'Bearer wrong' } });
    expect(hasCronAuthorization(valid, 'cron-secret')).toBe(true);
    expect(hasCronAuthorization(invalid, 'cron-secret')).toBe(false);
  });

  it('fails closed for missing internal secrets too', () => {
    const request = new Request('https://example.test', { headers: { 'x-internal-secret': 'undefined' } });
    expect(hasInternalSecret(request, '')).toBe(false);
    expect(hasInternalSecret(request, 'internal-secret')).toBe(false);
    expect(hasInternalSecret(new Request('https://example.test', { headers: { 'x-internal-secret': 'internal-secret' } }), 'internal-secret')).toBe(true);
  });

  it('keeps every scheduled route on the shared fail-closed helper', () => {
    // Sanity: the glob actually resolved routes (a silently-empty list would make
    // the loop below vacuously pass and hide a regression).
    expect(cronRoutes.length).toBeGreaterThanOrEqual(19);
    for (const file of cronRoutes) {
      const source = readFileSync(file, 'utf8');
      // Must both CALL the gate and ACT on it (reject) — importing without a 401
      // would leave the privileged job publicly triggerable.
      expect(source, file).toContain('hasCronAuthorization(');
      expect(source, `${file} must reject unauthorized callers`).toMatch(/401/);
      expect(source, file).not.toContain('process.env.CRON_SECRET');
      expect(source, file).not.toContain('Bearer ${process.env.CRON_SECRET}');
    }
    const welcome = readFileSync('app/api/email/welcome/route.ts', 'utf8');
    expect(welcome).toContain('hasInternalSecret');
    expect(welcome).toMatch(/401/);
    expect(welcome).not.toContain('process.env.INTERNAL_SECRET');
  });
});
