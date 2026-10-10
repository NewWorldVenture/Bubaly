import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemorySupabase } from './helpers/in-memory-supabase';

/**
 * A SECRET COPIED FROM .env.example AUTHENTICATES NOTHING (SEC-002).
 *
 * `.env.example` ships non-empty values for secrets that authenticate callers:
 * `STRIPE_WEBHOOK_SECRET=whsec_your_webhook_signing_secret`,
 * `RESEND_WEBHOOK_SECRET=whsec_your_resend_webhook_secret`, and
 * `INTERNAL_SECRET` / `GUARDIAN_INTERNAL_SECRET` / `CHILD_LOGIN_SECRET` all
 * `=generate_a_random_string`. Every read site refused an UNSET secret, and
 * none refused these. A deployment that copied the file unchanged verified
 * webhooks and internal calls signed with a secret anyone can read on GitHub.
 * A published secret is an unset one, and is answered the same way.
 */
const mocks = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => mocks.db }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/marketing/automation-events', () => ({ fireAutomationEvent: vi.fn() }));

const PLACEHOLDER = 'generate_a_random_string';

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  mocks.db = new InMemorySupabase();
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('shared-secret checks', () => {
  it('a placeholder expectation matches nothing, even itself', async () => {
    const { secretsMatch, bearerMatches } = await import('@/lib/server/secret-compare');
    expect(secretsMatch(PLACEHOLDER, PLACEHOLDER)).toBe(false);
    expect(bearerMatches(`Bearer ${PLACEHOLDER}`, PLACEHOLDER)).toBe(false);
    // Control: a real secret still matches.
    expect(secretsMatch('a-real-random-value-9f2c', 'a-real-random-value-9f2c')).toBe(true);
  });

  it('INTERNAL_SECRET and CRON_SECRET left as the placeholder authorize no request', async () => {
    vi.stubEnv('INTERNAL_SECRET', PLACEHOLDER);
    vi.stubEnv('CRON_SECRET', PLACEHOLDER);
    const { hasInternalSecret, hasCronAuthorization } = await import('@/lib/server/cron-auth');
    expect(hasInternalSecret(new Request('https://x.test', { headers: { 'x-internal-secret': PLACEHOLDER } }))).toBe(false);
    expect(hasCronAuthorization(new Request('https://x.test', { headers: { authorization: `Bearer ${PLACEHOLDER}` } }))).toBe(false);
  });
});

describe('webhook signing secrets', () => {
  it('Stripe: the placeholder signing secret is no signing secret', async () => {
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec_your_webhook_signing_secret');
    const { effectiveWebhookSecret } = await import('@/lib/stripe/settings');
    expect(effectiveWebhookSecret(null)).toBeNull();
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec_real_value_for_this_test');
    expect(effectiveWebhookSecret(null)).toBe('whsec_real_value_for_this_test');
  });

  it('Resend: an event signed with the published placeholder is refused and persists nothing', async () => {
    vi.stubEnv('RESEND_WEBHOOK_SECRET', 'whsec_your_resend_webhook_secret');
    // Exactly the key the route derives from that value.
    const key = Buffer.from('your_resend_webhook_secret', 'base64');
    const body = JSON.stringify({ type: 'email.complained', created_at: new Date().toISOString(), data: { email_id: 'msg_forged', to: ['victim@example.test'] } });
    const id = 'msg_forged_event';
    const ts = String(Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');
    const { POST } = await import('@/app/api/webhooks/resend/route');
    const res = await POST(new NextRequest('https://bubaly.test/api/webhooks/resend', {
      method: 'POST', body,
      headers: { 'content-type': 'application/json', 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${signature}` },
    }));
    expect(res.status).toBe(401);
    expect((mocks.db as InMemorySupabase).table('marketing_suppressions')).toEqual([]);
    expect((mocks.db as InMemorySupabase).table('resend_webhook_events')).toEqual([]);
  });
});
