import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { hasCronAuthorization, hasInternalSecret } from '@/lib/server/cron-auth';

const cronRoutes = [
  'app/api/cron/admin-digest/route.ts',
  'app/api/cron/automations/route.ts',
  'app/api/cron/autopilot-scan/route.ts',
  'app/api/cron/calendar-feeds/route.ts',
  'app/api/cron/checkout-abandoned/route.ts',
  'app/api/cron/chore-reminders/route.ts',
  'app/api/cron/close-auctions/route.ts',
  'app/api/cron/demo-cleanup/route.ts',
  'app/api/cron/guardian-learning/route.ts',
  'app/api/cron/journey-recovery/route.ts',
  'app/api/cron/model-refresh/route.ts',
  'app/api/cron/network-aggregate/route.ts',
  'app/api/cron/notifications/route.ts',
  'app/api/cron/provider-sync/route.ts',
  'app/api/cron/push-scan/route.ts',
  'app/api/cron/wallet-allowance/route.ts',
  'app/api/cron/weekly-digest/route.ts',
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
    for (const file of cronRoutes) {
      const source = readFileSync(file, 'utf8');
      expect(source, file).toContain('hasCronAuthorization');
      expect(source, file).not.toContain('process.env.CRON_SECRET');
      expect(source, file).not.toContain('Bearer ${process.env.CRON_SECRET}');
    }
    const welcome = readFileSync('app/api/email/welcome/route.ts', 'utf8');
    expect(welcome).toContain('hasInternalSecret');
    expect(welcome).not.toContain('process.env.INTERNAL_SECRET');
  });
});
