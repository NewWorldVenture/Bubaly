import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The real lib/email, with no RESEND_API_KEY: sendReactEmail answers
// { ok: true, skipped: true } and sends nothing. The invite route read only
// `ok` and answered { sent: true } — the inviter was told their invite had
// gone to someone who never received it. See
// tests/an-email-that-was-not-sent-is-not-reported-sent.test.ts for the class.

vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'u' },
    active: { familyId: 'f', role: 'parent', member: { display_name: 'Casey' }, family: { name: 'Rivera family' } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({
  createServer: async () => ({ from: () => {
    const b = { select: () => b, eq: () => b,
      maybeSingle: async () => ({ data: { id: 'i', email: 'grandma@example.test', token: 't', role: 'adult', status: 'pending', expires_at: new Date(Date.now() + 86_400_000).toISOString() }, error: null }) };
    return b;
  } }),
  // The family-wide invite limit is evaluated on the service client (API-SWEEP-08);
  // the limiter itself is mocked below, so the client is never used here.
  createServiceClient: () => ({}),
}));
vi.mock('@/lib/server/request-rate-limit', () => ({ enforceRequestRateLimit: async () => ({ ok: true }) }));

const saved = process.env.RESEND_API_KEY;
beforeEach(() => { delete process.env.RESEND_API_KEY; });
afterEach(() => { if (saved === undefined) delete process.env.RESEND_API_KEY; else process.env.RESEND_API_KEY = saved; });

describe('an invite on a server with no mail provider', () => {
  it('is not reported as sent', async () => {
    const { POST } = await import('@/app/api/email/invite/route');
    const res = await POST(new NextRequest('https://www.bubaly.com/api/email/invite', {
      method: 'POST', body: JSON.stringify({ inviteId: 'i' }), headers: { 'content-type': 'application/json' },
    }));
    const body = await res.json();
    expect(body).not.toEqual({ sent: true });
    expect(res.status).toBe(503);
    expect(body).toEqual({ error: 'invite.failedToSendInvite' });
  });
});
