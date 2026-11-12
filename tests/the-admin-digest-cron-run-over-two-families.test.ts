// The daily super-admin digest cron, driven as the scheduler drives it: the
// real exported GET on its default path (ADMIN_DIGEST_DELIVERY_ENGINE unset),
// the real `hasCronAuthorization` against a stubbed CRON_SECRET, the real
// paged feed read, recipient lookup, digest build/render and `sendEmail` down
// to `fetch`.
//
// Faked: the database (tests/helpers/in-memory-supabase.ts), translations
// (identity), the clock (Date only) and the email provider — a stub for global
// `fetch` that answers only https://api.resend.com/emails, records each
// request, and folds a repeated idempotency key with identical bytes the way
// Resend documents (24 h). Nothing leaves the process.
//
// Not repeated here: tests/admin-digest-recipients-fail-closed.test.ts (an
// unreadable or truncated super_admins list sends nothing), the occurrence
// arithmetic (tests/admin-digest-occurrence-and-provider.test.ts), the mirrored
// tick and catch-up (tests/a-mirrored-cron-must-be-idempotent.test.ts,
// tests/a-late-tick-catches-up.test.ts) and the flagged engine path
// (tests/admin-digest-route-engine*.test.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';

const state = vi.hoisted(() => ({ client: null as unknown, service: vi.fn() }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: state.service }));

const { GET } = await import('@/app/api/cron/admin-digest/route');
const { superAdminEmails } = await import('@/lib/constants/super-admins');

const SECRET = 'test-cron-secret-not-real';
const ENV_ADMIN = 'env-admin@example.com';
const TABLE_ADMIN = 'table-admin@example.com';
const REMOVED_ADMIN = 'removed-admin@example.com';
const PARENT_A = 'parent-alpha@example.com';
const PARENT_B = 'parent-bravo@example.com';

const FAMILY_A = '00000000-0000-4000-8000-0000000000a1';
const FAMILY_B = '00000000-0000-4000-8000-0000000000b1';

type Request = { to: string; key: string | null; subject: string; html: string; body: string };
type Provider = { requests: Request[]; delivered: Map<string, Request>; stray: string[]; refuse: Set<string> };
const provider: Provider = { requests: [], delivered: new Map(), stray: [], refuse: new Set() };

let db: InMemorySupabase;

function happen(id: string, kind: string, title: string, at: string, familyId: string) {
  db.seed('admin_notifications', [{ id, kind, title, created_at: at, related_type: 'family', related_id: familyId }]);
}

/**
 * Two households' activity inside the 24 h window ending 2026-11-12 12:30 UTC,
 * one row just before the window and one at its (exclusive) end, three table
 * admins (one of whom is later removed) and each household's parent, who must
 * never be mailed.
 */
function seed() {
  db.seed('families', [{ id: FAMILY_A, closed_at: null }, { id: FAMILY_B, closed_at: null }]);
  db.seed('family_members', [
    { id: '00000000-0000-4000-8000-0000000001a1', family_id: FAMILY_A, email: PARENT_A, role: 'parent' },
    { id: '00000000-0000-4000-8000-0000000001b1', family_id: FAMILY_B, email: PARENT_B, role: 'parent' },
  ]);
  db.seed('super_admins', [{ email: TABLE_ADMIN }, { email: REMOVED_ADMIN }]);
  happen('00000000-0000-4000-8000-000000000101', 'family_signup', 'Alpha household joined', '2026-11-11T14:00:00.000Z', FAMILY_A);
  happen('00000000-0000-4000-8000-000000000102', 'subscription', 'Alpha household went Premium', '2026-11-12T09:00:00.000Z', FAMILY_A);
  happen('00000000-0000-4000-8000-000000000103', 'family_signup', 'Bravo household joined', '2026-11-12T12:29:59.999Z', FAMILY_B);
  happen('00000000-0000-4000-8000-000000000104', 'family_signup', 'Before the window', '2026-11-11T12:29:59.999Z', FAMILY_B);
  happen('00000000-0000-4000-8000-000000000105', 'family_signup', 'At the window end', '2026-11-12T12:30:00.000Z', FAMILY_A);
}

async function runAt(at: string, authorization: string | null = `Bearer ${SECRET}`) {
  vi.setSystemTime(new Date(at));
  const res = await GET(new Request('https://bubaly.test/api/cron/admin-digest', authorization === null ? {} : { headers: { authorization } }) as never);
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}
const admins = () => [...new Set([...superAdminEmails(), TABLE_ADMIN, REMOVED_ADMIN])].sort();
const keysByRecipient = (requests: Request[]) => Object.fromEntries(requests.map((r) => [r.to, r.key]));

const saved = { ...process.env };
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  for (const k of ['ADMIN_DIGEST_DELIVERY_ENGINE']) delete process.env[k];
  vi.stubEnv('CRON_SECRET', SECRET);
  vi.stubEnv('RESEND_API_KEY', 're_test_not_a_real_key');
  vi.stubEnv('SUPER_ADMIN_EMAILS', ENV_ADMIN);
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example.com');
  db = createInMemorySupabase();
  state.client = db;
  state.service.mockReset();
  state.service.mockImplementation(() => state.client);
  provider.requests = []; provider.delivered = new Map(); provider.stray = []; provider.refuse = new Set();
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    if (String(input) !== 'https://api.resend.com/emails') { provider.stray.push(String(input)); throw new Error('network is disabled in this test'); }
    const body = String(init?.body);
    const parsed = JSON.parse(body) as { to: string; subject: string; html: string };
    const key = (init?.headers as Record<string, string> | undefined)?.['idempotency-key'] ?? null;
    const request = { to: parsed.to, key, subject: parsed.subject, html: parsed.html, body };
    provider.requests.push(request);
    if (provider.refuse.has(parsed.to)) return new Response('{"name":"internal_server_error"}', { status: 500 });
    const prior = key === null ? undefined : provider.delivered.get(key);
    if (prior && prior.body !== body) return new Response('{"name":"invalid_idempotent_request"}', { status: 409 });
    if (!prior) provider.delivered.set(key ?? `unkeyed-${provider.requests.length}`, request);
    return new Response('{"id":"msg_test"}', { status: 200 });
  }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  expect(provider.stray, 'no call may leave the process').toEqual([]);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const k of ['ADMIN_DIGEST_DELIVERY_ENGINE']) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});

describe('authorization comes before any read', () => {
  const refused: [string, string | null][] = [
    ['no Authorization header', null],
    ['a wrong secret', 'Bearer not-the-cron-secret'],
    ['the right secret without the Bearer scheme', SECRET],
  ];
  for (const [label, header] of refused) {
    it(`API-96040DFB5635 JOB-EF2453D9F633: ${label} answers 401 and touches nothing`, async () => {
      seed();
      const res = await runAt('2026-11-12T12:45:00.000Z', header);
      expect(res).toEqual({ status: 401, body: { error: 'adminDigest.unauthorized' } });
      expect(state.service).not.toHaveBeenCalled();
      expect(db.log).toEqual([]);
      expect(provider.requests).toEqual([]);
    });
  }

  it('API-96040DFB5635 JOB-EF2453D9F633: with the delivery engine switched on, a wrong secret is still refused before the engine or any read', async () => {
    vi.stubEnv('ADMIN_DIGEST_DELIVERY_ENGINE', '1');
    seed();
    const res = await runAt('2026-11-12T12:45:00.000Z', 'Bearer not-the-cron-secret');
    expect(res.status).toBe(401);
    expect(state.service).not.toHaveBeenCalled();
    expect(db.log).toEqual([]);
    expect(provider.requests).toEqual([]);
  });
});

describe('a populated run over two households', () => {
  it('API-96040DFB5635 JOB-EF2453D9F633: counts only the window\'s rows from both households and mails each super admin once, writing nothing', async () => {
    seed();
    const before = JSON.stringify(['admin_notifications', 'super_admins', 'families', 'family_members'].map((t) => db.table(t)));
    const res = await runAt('2026-11-12T12:45:00.000Z');

    expect(res).toEqual({
      status: 200,
      body: {
        ok: true, sent: admins().length, skipped: 0, failed: 0, recipients: admins().length, total: 3,
        headline: '1 new paid plan and 2 new families.', occurrence: 'admin-digest:2026-11-12T12:30:00.000Z',
      },
    });
    expect(provider.requests.map((r) => r.to).sort()).toEqual(admins());
    for (const request of provider.requests) {
      expect(request.subject).toContain('Nov 12');
      expect(request.html).toContain('Alpha household joined');
      expect(request.html).toContain('Alpha household went Premium');
      expect(request.html).toContain('Bravo household joined');
      expect(request.html).not.toContain('Before the window');
      expect(request.html).not.toContain('At the window end');
    }
    expect(new Set(db.log.map((entry) => entry.table))).toEqual(new Set(['admin_notifications', 'super_admins']));
    expect(JSON.stringify(['admin_notifications', 'super_admins', 'families', 'family_members'].map((t) => db.table(t)))).toBe(before);
  });

  it('API-96040DFB5635 JOB-EF2453D9F633: a household\'s activity reaches super admins only, never a family member, each under a key of its own', async () => {
    seed();
    await runAt('2026-11-12T12:45:00.000Z');
    const recipients = provider.requests.map((r) => r.to);
    expect(recipients).not.toContain(PARENT_A);
    expect(recipients).not.toContain(PARENT_B);
    const keys = provider.requests.map((r) => r.key);
    expect(new Set(keys).size).toBe(provider.requests.length);
    for (const request of provider.requests) {
      expect(request.key).toMatch(/^admin-digest\/[0-9a-f]{64}$/);
      expect(request.key).not.toContain(request.to);
    }
  });

  it('API-96040DFB5635 JOB-EF2453D9F633: a quiet window sends nothing and does not read recipients', async () => {
    seed();
    const res = await runAt('2026-11-14T12:45:00.000Z');
    expect(res).toEqual({ status: 200, body: { ok: true, sent: 0, total: 0, reason: 'no activity in the last 24h' } });
    expect(provider.requests).toEqual([]);
    expect(db.log.map((entry) => entry.table)).not.toContain('super_admins');
  });
});

describe('a second tick, and ticks that fail part way', () => {
  it('API-96040DFB5635 JOB-EF2453D9F633: a later tick for the same occurrence repeats each key with identical bytes, so nothing new is delivered; a removed admin is not asked again', async () => {
    seed();
    await runAt('2026-11-12T12:45:00.000Z');
    const first = keysByRecipient(provider.requests);
    const firstBodies = Object.fromEntries(provider.requests.map((r) => [r.to, r.body]));
    const deliveredAfterFirst = provider.delivered.size;

    db.replace('super_admins', db.table('super_admins').filter((r) => r.email !== REMOVED_ADMIN));
    happen('00000000-0000-4000-8000-000000000106', 'family_signup', 'After the slot', '2026-11-12T12:50:00.000Z', FAMILY_B);
    provider.requests = [];
    const again = await runAt('2026-11-12T13:10:00.000Z');

    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ ok: true, failed: 0, total: 3, occurrence: 'admin-digest:2026-11-12T12:30:00.000Z', recipients: admins().length - 1 });
    expect(provider.requests.map((r) => r.to)).not.toContain(REMOVED_ADMIN);
    for (const request of provider.requests) {
      expect(request.key).toBe(first[request.to]);
      expect(request.body).toBe(firstBodies[request.to]);
    }
    expect(provider.delivered.size).toBe(deliveredAfterFirst);
  });

  it('API-96040DFB5635 JOB-EF2453D9F633: an unreadable notification feed answers 502 and mails no one', async () => {
    seed();
    state.client = withFaults(db, (table) => (table === 'admin_notifications' ? { code: '08006', message: 'injected: feed read failed' } : null));
    const res = await runAt('2026-11-12T12:45:00.000Z');
    expect(res).toEqual({ status: 502, body: { ok: false, error: 'adminDigest.notificationFeedUnavailable' } });
    expect(provider.requests).toEqual([]);
  });

  it('API-96040DFB5635 JOB-EF2453D9F633: one refused send is a counted failure (502) while the others are delivered; the retry tick delivers it under the same key and nobody twice', async () => {
    seed();
    provider.refuse.add(TABLE_ADMIN);
    const res = await runAt('2026-11-12T12:45:00.000Z');
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ ok: false, sent: admins().length - 1, failed: 1, recipients: admins().length, total: 3 });
    expect([...provider.delivered.values()].map((r) => r.to).sort()).toEqual(admins().filter((a) => a !== TABLE_ADMIN));
    const refusedKey = provider.requests.find((r) => r.to === TABLE_ADMIN)!.key;

    provider.refuse.clear();
    const retry = await runAt('2026-11-12T13:00:00.000Z');
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ ok: true, failed: 0, sent: admins().length });
    expect([...provider.delivered.values()].map((r) => r.to).sort()).toEqual(admins());
    expect(provider.delivered.get(refusedKey!)?.to).toBe(TABLE_ADMIN);
  });
});
