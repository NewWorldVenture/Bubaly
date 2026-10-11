import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// Found by running every cron on a local production build with no mail
// provider: /api/cron/weekly-digest answered `sent: 13`. With RESEND_API_KEY
// unset the sender answers `{ ok: true, skipped: true }` and sends nothing, and
// most of its callers read only `ok`. The contact form already knew this
// (C3-S5-05); the others did not. Fixed on main by #619 (API-SWEEP-07), found in
// parallel by another session; tests/an-invite-with-no-mail-provider-is-not-sent
// is its invite case. This file adds the welcome route and the delivered path.
//
// The visible one is the invite. The invite form says "Invite sent" on any 2xx
// from /api/email/invite, and the route answered `{ sent: true }` for a mail
// that never left, so a parent was told their partner had an invitation in
// their inbox. The two cron counters are pinned in their own driven tests
// (the-weekly-digest-reaches-every-family, digest-cron-read-boundary).

const state = vi.hoisted(() => ({ result: { ok: true, skipped: true } as { ok: boolean; skipped?: boolean }, sends: 0 }));

vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'u1' },
    active: { familyId: 'f1', role: 'parent', member: { display_name: 'Pat' }, family: { name: 'Fixture' } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({
  createServer: async () => ({
    from: () => {
      const b: Record<string, unknown> = {};
      Object.assign(b, {
        select: () => b, eq: () => b,
        maybeSingle: async () => ({ data: { id: 'inv-1', email: 'partner@example.test', token: 'tok', role: 'parent', status: 'pending', expires_at: '2999-01-01T00:00:00Z' }, error: null }),
      });
      return b;
    },
  }),
  createServiceClient: () => ({}),
}));
// The welcome route is called by our own server actions with the internal secret.
vi.mock('@/lib/server/cron-auth', () => ({ hasInternalSecret: () => true }));
vi.mock('@/lib/server/request-rate-limit', () => ({ enforceRequestRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/emails/invite', () => ({ InviteEmail: () => null }));
vi.mock('@/lib/emails/welcome', () => ({ WelcomeEmail: () => null }));
vi.mock('@/lib/email', () => ({
  sendReactEmail: async () => { state.sends++; return state.result; },
}));

function post(path: string, body: unknown) {
  return new NextRequest(`https://www.bubaly.com${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
}

beforeEach(() => {
  state.sends = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('an email nobody sent is not reported as sent', () => {
  it('the invite route does not answer 2xx when no mail provider sent it', async () => {
    state.result = { ok: true, skipped: true };
    const { POST } = await import('@/app/api/email/invite/route');
    const res = await POST(post('/api/email/invite', { inviteId: 'inv-1' }));
    expect(state.sends).toBe(1);
    expect(res.status).toBe(503);
    expect((await res.json()).sent).toBeUndefined();
  });

  it('the invite route still answers sent when the provider accepted it', async () => {
    state.result = { ok: true };
    const { POST } = await import('@/app/api/email/invite/route');
    const res = await POST(post('/api/email/invite', { inviteId: 'inv-1' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: true });
  });

  it('the welcome route does not answer sent when no mail provider sent it', async () => {
    state.result = { ok: true, skipped: true };
    const { POST } = await import('@/app/api/email/welcome/route');
    const res = await POST(post('/api/email/welcome', { email: 'new@example.test', name: 'New' }));
    expect(res.status).toBe(503);
  });
});
