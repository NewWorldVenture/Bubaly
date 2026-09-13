// An unsubscribe that did not land must not be reported as one.
//
// The route's upsert into `marketing_suppressions` IS the unsubscribe —
// lib/marketing/send.ts drops an address from a campaign only by finding its row
// there. That upsert's result was discarded, and the page it renders promises,
// with a tick and a 200, that the address "will no longer receive marketing
// emails from Bubaly". So a refused write sent a person away believing they had
// opted out, and the next campaign mailed them anyway.
//
// What makes this a gap rather than the house style is that every other path
// touching this table already treats the write as load-bearing:
//
//   lib/marketing/send.ts          throws and abandons the send if it cannot
//                                  READ suppressions — it will not mail anyone
//                                  rather than risk mailing someone who opted out
//   app/api/webhooks/resend/route  answers 503 on a failed bounce/complaint
//                                  write so the provider retries
//
// Both machine-facing paths are careful. The one path where a human is told
// something was the one that did not check.
//
// POST is also the RFC 8058 one-click endpoint (List-Unsubscribe-Post), so the
// status is not cosmetic: a 2xx is what tells Gmail or Yahoo the opt-out was
// honoured. Answering 200 on a failed write spends the provider's only signal on
// a promise that was not kept.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ admin: vi.fn(), rateLimit: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: mocks.admin }));
vi.mock('@/lib/server/request-rate-limit', () => ({ enforceRequestRateLimit: mocks.rateLimit }));

const EMAIL = 'parent@example.com';

/** A client whose upsert RESOLVES with `outcome`, the way PostgREST does. */
function client(outcome: { error: { code: string; message: string } | null }) {
  const upserts: unknown[] = [];
  const c = {
    from: () => ({
      upsert: async (row: unknown) => { upserts.push(row); return { data: null, ...outcome }; },
    }),
  };
  return { c, upserts };
}

let token: string;
beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubEnv('MARKETING_UNSUB_SECRET', 'test-unsub-secret');
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  mocks.rateLimit.mockResolvedValue({ ok: true });
  const { unsubToken } = await import('@/lib/marketing/unsubscribe');
  token = unsubToken(EMAIL);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function call(method: 'GET' | 'POST', email = EMAIL, t = token) {
  const { NextRequest } = await import('next/server');
  const route = await import('@/app/api/marketing/unsubscribe/route');
  const url = `https://bubaly.test/api/marketing/unsubscribe?e=${encodeURIComponent(email)}&t=${t}`;
  const req = new NextRequest(url, { method });
  return method === 'GET' ? route.GET(req) : route.POST(req);
}

describe('a suppression write that did not land is not reported as unsubscribed', () => {
  it.each(['GET', 'POST'] as const)('%s answers 503 and does not claim the opt-out', async (method) => {
    const { c, upserts } = client({ error: { code: '42501', message: 'permission denied' } });
    mocks.admin.mockReturnValue(c);

    const res = await call(method);
    const html = await res.text();

    // It genuinely tried.
    expect(upserts).toEqual([{ email: EMAIL, reason: 'unsubscribe' }]);
    // And then told the truth about what happened.
    expect(res.status, 'a failed unsubscribe answered a success status').toBe(503);
    expect(html, 'the page promised an opt-out that was never recorded')
      .not.toContain('will no longer receive marketing emails');
    expect(html).not.toContain('>✓<');
    // The honest version has to say the mail may keep coming, or the reader has
    // no reason to try again.
    expect(html).toContain('may still receive marketing email');
  });

  it('GET reports the opt-out only when the write landed', async () => {
    const { c, upserts } = client({ error: null });
    mocks.admin.mockReturnValue(c);

    const res = await call('GET');
    const html = await res.text();

    expect(upserts).toHaveLength(1);
    expect(res.status).toBe(200);
    expect(html).toContain('will no longer receive marketing emails');
    expect(html).toContain(EMAIL);
  });

  it('normalizes the address it suppresses, so the send-side lookup matches', async () => {
    const { c, upserts } = client({ error: null });
    mocks.admin.mockReturnValue(c);
    const { unsubToken } = await import('@/lib/marketing/unsubscribe');

    const res = await call('POST', '  PARENT@Example.COM ', unsubToken('  PARENT@Example.COM '));
    expect(res.status).toBe(200);
    // send.ts matches with .in('email', [...]) on lowercased addresses; a row
    // stored with the user's own capitals would never be found, which is the
    // same failure as not writing it at all.
    expect(upserts).toEqual([{ email: EMAIL, reason: 'unsubscribe' }]);
  });

  it('never reaches the write for a token that does not verify', async () => {
    const { c, upserts } = client({ error: null });
    mocks.admin.mockReturnValue(c);

    const res = await call('GET', EMAIL, 'a'.repeat(64));
    expect(res.status).toBe(400);
    expect(upserts, 'an unverified link suppressed an address anyway').toEqual([]);
  });

  it('does not write when the request is rate limited', async () => {
    const { c, upserts } = client({ error: null });
    mocks.admin.mockReturnValue(c);
    mocks.rateLimit.mockResolvedValue({ ok: false, retryAfter: 42 });

    const res = await call('POST');
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('42');
    expect(upserts).toEqual([]);
  });
});
