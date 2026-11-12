// POST /api/email/welcome, driven end to end (Register B API-F65D59457C92).
//
// An internal server-to-server endpoint: no session, no household, no table.
// It is authorised only by `x-internal-secret` matching INTERNAL_SECRET
// (lib/server/cron-auth.ts hasInternalSecret → secretsMatch), and it mails the
// address in its body. The secret is stubbed with vi.stubEnv and the real
// comparison runs; the mail seam is `@/lib/email`'s sendReactEmail, the one
// tests/an-email-nobody-sent-is-not-reported-as-sent.test.ts stubs.
//
// Already proven elsewhere: the no-provider 503 (an-email-nobody-sent-is-not-
// reported-as-sent, which mocks hasInternalSecret to true); the route uses the
// shared helper (cron-auth, a source scan); the secret compare itself
// (shared-secrets-compare-in-constant-time). Not proven anywhere until now: the
// real secret check on the route, and what the route does with a valid call.
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({ db: null as unknown, send: vi.fn() }));

vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db, createServer: async () => h.db }));
vi.mock('@/lib/email', () => ({ sendReactEmail: h.send }));

const SECRET = 'test-fake-internal-secret-0123456789';
let db: InMemorySupabase;

async function post(headers: Record<string, string>, body: unknown = { email: 'new.parent@example.com', name: 'Robin' }) {
  const { POST } = await import('@/app/api/email/welcome/route');
  return POST(new NextRequest('https://www.bubaly.com/api/email/welcome', {
    method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers },
  }));
}

beforeEach(() => {
  db = createInMemorySupabase();
  h.db = db;
  h.send.mockReset().mockResolvedValue({ ok: true });
  vi.stubEnv('INTERNAL_SECRET', SECRET);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('who may trigger a welcome email (member roles n/a: internal secret only)', () => {
  it.each([
    ['no secret header', {}],
    ['a wrong secret of the same length', { 'x-internal-secret': SECRET.replace(/.$/, 'X') }],
    ['a wrong secret of another length', { 'x-internal-secret': 'test-fake-guess' }],
    ['the secret as a bearer token instead of the header', { authorization: `Bearer ${SECRET}` }],
    ['a signed-in session cookie and no secret', { cookie: 'sb-access-token=test-fake-session' }],
  ])('API-F65D59457C92 %s is refused 401 and mails nothing', async (_label, headers) => {
    const res = await post(headers);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'welcome.unauthorized' });
    expect(h.send).not.toHaveBeenCalled();
    expect(db.log).toHaveLength(0);
  });

  it('API-F65D59457C92 with INTERNAL_SECRET unset, no presented value matches (not even an empty or "undefined" one)', async () => {
    vi.stubEnv('INTERNAL_SECRET', '');
    for (const presented of ['', 'undefined']) {
      const res = await post({ 'x-internal-secret': presented });
      expect(res.status).toBe(401);
    }
    expect(h.send).not.toHaveBeenCalled();
  });

  it('API-F65D59457C92 the .env.example placeholder is not a secret even when presented exactly', async () => {
    vi.stubEnv('INTERNAL_SECRET', 'generate_a_random_string');
    const res = await post({ 'x-internal-secret': 'generate_a_random_string' });
    expect(res.status).toBe(401);
    expect(h.send).not.toHaveBeenCalled();
  });
});

describe('a valid internal call', () => {
  it('API-F65D59457C92 the correct secret mails the named address once, answers sent:true and touches no table', async () => {
    const res = await post({ 'x-internal-secret': SECRET });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: true });
    expect(h.send).toHaveBeenCalledTimes(1);
    const [message] = h.send.mock.calls[0] as [{ to: string; subject: string; react: { props: Record<string, unknown> } }];
    expect(message.to).toBe('new.parent@example.com');
    expect(message.subject).toBe('Welcome to Bubaly 🎉');
    expect(message.react.props).toEqual({ name: 'Robin' });
    expect(db.log).toHaveLength(0);
  });

  it('API-F65D59457C92 an over-long address or name is refused 400 before any send', async () => {
    const long = await post({ 'x-internal-secret': SECRET }, { email: `${'a'.repeat(310)}@example.com`, name: 'Robin' });
    expect(long.status).toBe(400);
    const longName = await post({ 'x-internal-secret': SECRET }, { email: 'new.parent@example.com', name: 'R'.repeat(121) });
    expect(longName.status).toBe(400);
    expect(h.send).not.toHaveBeenCalled();
  });
});

describe('another household\'s ids: n/a (the body carries no household id)', () => {
  it('API-F65D59457C92 a household id in the body is ignored: nothing is read or written for it', async () => {
    const res = await post({ 'x-internal-secret': SECRET }, {
      email: 'new.parent@example.com', name: 'Robin', familyId: 'bbbbbbbb-0000-4000-8000-00000000000b',
    });
    expect(res.status).toBe(200);
    expect(db.log).toHaveLength(0);
    expect((h.send.mock.calls[0] as [{ react: { props: Record<string, unknown> } }])[0].react.props).toEqual({ name: 'Robin' });
  });
});

describe('failure', () => {
  it('API-F65D59457C92 a provider that refuses the mail answers 502, never sent:true', async () => {
    h.send.mockResolvedValue({ ok: false });
    const res = await post({ 'x-internal-secret': SECRET });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'welcome.failedToSendWelcomeEmail' });
  });

  it('API-F65D59457C92 a sender that throws answers a generic 500 with none of the thrown text', async () => {
    h.send.mockRejectedValue(new Error('resend: invalid api key re_test_fake_key at /v1/emails'));
    const res = await post({ 'x-internal-secret': SECRET });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: 'welcome.failedToSendWelcomeEmail' });
    expect(text).not.toContain('re_test_fake_key');
  });
});
