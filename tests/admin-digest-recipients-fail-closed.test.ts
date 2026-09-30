// The admin digest fails CLOSED when it cannot read its recipient list.
//
// The recipients are the code/env allowlist (lib/constants/super-admins.ts) plus
// every row of `super_admins`. Before this fix the lookup read the table with a
// bare `const { data } = await …`: a PostgREST error resolved to "no rows", a
// thrown query was swallowed by an empty catch, and the digest went out to the
// allowlist alone and answered 200 ok. A super admin who exists only in the table
// simply stopped receiving it, and nothing anywhere said so (#677 characterized
// this; its contract case C6 is the same requirement).
//
// The contract pinned here:
//   - a failed, thrown or truncated `super_admins` read sends NOTHING and answers
//     502, so the scheduler sees a failed run rather than a partial one;
//   - a SUCCESSFUL read with zero rows is not an error: the configured allowlist
//     is the legitimate recipient list, as before;
//   - a successful read with rows is the allowlist ∪ the table, lowercased and
//     de-duplicated, as before.
//
// Real: the route handler, cron auth, readAll paging, the recipient lookup and
// sendEmail down to `fetch`. Fake: the database (tests/helpers/in-memory-supabase),
// the clock (Date only), translations (identity) and the email provider, which is
// a stub for global `fetch` that counts attempts and fails the test on any other
// URL. Nothing is sent.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const state = vi.hoisted(() => ({
  db: null as unknown,
  attempts: [] as string[],
  stray: [] as string[],
  failSuperAdmins: null as null | 'error' | 'throw',
  superAdminReads: 0,
}));

vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => state.db }));

const { GET } = await import('@/app/api/cron/admin-digest/route');
const { superAdminEmails } = await import('@/lib/constants/super-admins');

const CRON = 'test-cron-secret-not-real';
const TABLE_ADMIN = 'table-admin@example.test';
const ENV_ADMIN = 'env-admin@example.test';

let db: InMemorySupabase;
function client() {
  return {
    from(table: string) {
      const qb = db.from(table) as unknown as { then: (f?: (v: unknown) => unknown, r?: (e: unknown) => unknown) => Promise<unknown> };
      if (table !== 'super_admins') return qb;
      const then = qb.then.bind(qb);
      qb.then = (f, r) => {
        state.superAdminReads += 1;
        if (state.failSuperAdmins === 'throw') return Promise.reject(new Error('injected: super_admins read threw')).then(f, r);
        if (state.failSuperAdmins === 'error') {
          return Promise.resolve({ data: null, error: { code: 'XX000', message: 'injected: super_admins read failed', details: null, hint: null }, count: null, status: 500, statusText: 'Internal Server Error' }).then(f, r);
        }
        return then(f, r);
      };
      return qb;
    },
  };
}
function happen(at: string, title: string) {
  db.seed('admin_notifications', [{ id: `n-${title}`, kind: 'family_signup', title, created_at: new Date(at).toISOString() }]);
}
async function runAt(at: string) {
  vi.setSystemTime(new Date(at));
  const res = await GET(new Request('https://bubaly.test/api/cron/admin-digest', { headers: { authorization: `Bearer ${CRON}` } }) as never);
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

const saved = { ...process.env };
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  process.env.CRON_SECRET = CRON;
  process.env.RESEND_API_KEY = 'test-resend-key-not-real';
  process.env.SUPER_ADMIN_EMAILS = ENV_ADMIN;
  db = createInMemorySupabase();
  state.db = client();
  state.attempts = []; state.stray = []; state.failSuperAdmins = null; state.superAdminReads = 0;
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    if (String(input) !== 'https://api.resend.com/emails') { state.stray.push(String(input)); throw new Error('network is disabled in this hermetic test'); }
    state.attempts.push((JSON.parse(String(init?.body)) as { to: string }).to);
    return new Response('{"id":"msg"}', { status: 200 });
  }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
  expect(state.stray, 'no call may leave the process').toEqual([]);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const k of ['CRON_SECRET', 'RESEND_API_KEY', 'SUPER_ADMIN_EMAILS']) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});

const allowlist = () => superAdminEmails(); // built-in + SUPER_ADMIN_EMAILS, lowercased

describe('admin digest: an unreadable recipient list sends nothing', () => {
  for (const how of ['error', 'throw'] as const) {
    it(`a super_admins read that ${how === 'error' ? 'answers an error' : 'throws'}: 502, not one email, not 200 ok`, async () => {
      db.seed('super_admins', [{ email: TABLE_ADMIN }]);
      happen('2026-09-30T08:00:00Z', 'Signup Alpha');
      state.failSuperAdmins = how;
      const res = await runAt('2026-09-30T12:30:00Z');
      expect(state.superAdminReads).toBeGreaterThan(0);
      expect(res.status).toBe(502);
      expect(res.body).toMatchObject({ ok: false, error: 'adminDigest.recipientsUnavailable' });
      expect(state.attempts).toEqual([]);
    });
  }

  it('a super_admins list longer than the read ceiling is a truncated read: 502, not one email', async () => {
    db.seed('super_admins', Array.from({ length: 1_001 }, (_, i) => ({ email: `admin-${String(i).padStart(4, '0')}@example.test` })));
    happen('2026-09-30T08:00:00Z', 'Signup Alpha');
    const res = await runAt('2026-09-30T12:30:00Z');
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ ok: false, error: 'adminDigest.recipientsUnavailable' });
    expect(state.attempts).toEqual([]);
  });
});

describe('admin digest: a readable recipient list behaves as before', () => {
  it('a successful read with ZERO rows is not an error: the configured allowlist receives it, 200', async () => {
    happen('2026-09-30T08:00:00Z', 'Signup Alpha');
    const res = await runAt('2026-09-30T12:30:00Z');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, sent: allowlist().length, failed: 0, recipients: allowlist().length });
    expect([...state.attempts].sort()).toEqual([...allowlist()].sort());
    expect(state.attempts).toContain(ENV_ADMIN);
  });

  it('a successful read with rows: the allowlist plus the table, lowercased and de-duplicated, 200', async () => {
    db.seed('super_admins', [{ email: TABLE_ADMIN.toUpperCase() }, { email: ENV_ADMIN.toUpperCase() }, { email: null }]);
    happen('2026-09-30T08:00:00Z', 'Signup Alpha');
    const res = await runAt('2026-09-30T12:30:00Z');
    const expected = [...new Set([...allowlist(), TABLE_ADMIN])].sort();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, sent: expected.length, recipients: expected.length });
    expect([...state.attempts].sort()).toEqual(expected);
  });

  it('a quiet day still answers before looking up recipients at all', async () => {
    state.failSuperAdmins = 'error';
    const res = await runAt('2026-09-30T12:30:00Z');
    expect(res).toEqual({ status: 200, body: { ok: true, sent: 0, total: 0, reason: 'no activity in the last 24h' } });
    expect(state.superAdminReads).toBe(0);
  });
});
