// API-E3E78AD03D61 (GET) and API-262A058A148E (POST) — /api/marketing/unsubscribe,
// request level.
//
// The public unsubscribe link (GET) and its RFC 8058 one-click form (POST).
// No session is read: the HMAC token in `t` over the address in `e`
// (lib/marketing/unsubscribe.ts) is the whole authority, and the one write is
// a row in marketing_suppressions (email PRIMARY KEY, 0021), plus the
// canonical inbox for an alias.
//
// Already proven elsewhere, and not repeated here:
//   tests/marketing-unsubscribe-route.test.ts — a refused upsert answers 503 on
//     both methods without claiming the opt-out; the address is normalised; a
//     token that does not verify never reaches the write; a limited request
//     writes nothing (limiter mocked).
//   tests/an-alias-unsubscribe-holds-for-the-whole-inbox.test.ts — POST from an
//     alias records the canonical inbox and leaves an existing inbox row alone.
//   tests/public-side-effect-rate-limit.test.ts — the shared limiter is imported.
//
// Added here, over the in-memory database with the real limiter and the real
// token: GET end to end with the row read back; a second click is idempotent;
// a signed-in member of any role gets nothing more and no session is read; a
// link for one inbox cannot opt out another (nor touch the other's row); the
// real 30-a-minute limit and a durable limiter that cannot answer; an
// unconfigured secret answered 503; a failed canonical-inbox write answered
// 503; and an address in the page is escaped.
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';
import { rateLimitHit } from './helpers/rate-limit-rpc';

const h = vi.hoisted(() => ({ db: null as unknown, createServer: vi.fn(), limiterDown: false }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db, createServer: h.createServer }));

const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';
const FAMILY_A = '4a000000-0000-4000-8000-00000000000a';
const ROLES = ['parent', 'adult', 'teen', 'child', 'caregiver', 'guest'] as const;
const PRIVATE_DETAIL = 'duplicate key internal detail from marketing_suppressions_pkey';

let db: InMemorySupabase;

/** PostgREST's upsert with no onConflict targets the primary key — `email` on this table (0021). */
function primaryKeyUpserts(client: InMemorySupabase): InMemorySupabase {
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property !== 'from') return Reflect.get(target, property, receiver);
      return (table: string) => {
        const builder = target.from(table);
        if (table !== 'marketing_suppressions') return builder;
        const upsert = builder.upsert.bind(builder);
        return Object.assign(builder, {
          upsert: (rows: Parameters<typeof upsert>[0], opts?: Parameters<typeof upsert>[1]) => upsert(rows, opts ?? { onConflict: 'email' }),
        });
      };
    },
  });
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('MARKETING_UNSUB_SECRET', 'test-only-unsub-secret-0001');
  h.createServer.mockReset();
  h.limiterDown = false;
  db = createInMemorySupabase({
    uniques: { marketing_suppressions: [['email']] },
    rpc: {
      rate_limit_hit: (args, store) => {
        if (h.limiterDown) throw new Error('limiter offline');
        return rateLimitHit(args, store);
      },
    },
  });
  db.seed('marketing_suppressions', [{ email: BOB, reason: 'complaint', campaign_id: null }]);
  db.seed('family_members', [{ family_id: FAMILY_A, user_id: 'user-a', role: 'parent', is_active: true, display_name: 'Parent A' }]);
  h.db = primaryKeyUpserts(db);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

async function tokenFor(email: string) {
  return (await import('@/lib/marketing/unsubscribe')).unsubToken(email);
}

async function click(method: 'GET' | 'POST', email: string, token: string, opts: { ip?: string | null; cookie?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.ip !== null) headers['x-forwarded-for'] = opts.ip ?? '203.0.113.20';
  if (opts.cookie) headers.cookie = opts.cookie;
  const request = new NextRequest(
    `https://bubaly.example/api/marketing/unsubscribe?e=${encodeURIComponent(email)}&t=${token}`,
    { method, headers },
  );
  const route = await import('@/app/api/marketing/unsubscribe/route');
  return method === 'GET' ? route.GET(request) : route.POST(request);
}

const suppressions = () => db.table('marketing_suppressions').map((row) => ({ email: row.email, reason: row.reason }));

describe('API-E3E78AD03D61 GET and API-262A058A148E POST /api/marketing/unsubscribe', () => {
  it('API-E3E78AD03D61 a signed-out GET with a valid link records the opt-out and says so', async () => {
    const response = await click('GET', ALICE, await tokenFor(ALICE));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const html = await response.text();
    expect(html).toContain(`${ALICE} will no longer receive marketing emails`);
    expect(suppressions()).toEqual([{ email: BOB, reason: 'complaint' }, { email: ALICE, reason: 'unsubscribe' }]);
  });

  it.each(['GET', 'POST'] as const)('API-262A058A148E a second %s click is still unsubscribed and writes no second row', async (method) => {
    const token = await tokenFor(ALICE);
    expect((await click(method, ALICE, token, { ip: '203.0.113.21' })).status).toBe(200);
    expect((await click(method, ALICE, token, { ip: '203.0.113.21' })).status).toBe(200);
    expect(suppressions().filter((row) => row.email === ALICE)).toEqual([{ email: ALICE, reason: 'unsubscribe' }]);
    expect(db.table('marketing_suppressions')).toHaveLength(2);
  });

  it.each(ROLES)('API-262A058A148E a signed-in %s gets the same answer, no session is read, and only the suppression table is touched', async (role) => {
    db.table('family_members')[0].role = role;
    const response = await click('POST', ALICE, await tokenFor(ALICE), { ip: '203.0.113.22', cookie: 'sb-bubaly-auth-token=member-session' });
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain('Parent A');
    expect(h.createServer).not.toHaveBeenCalled();
    expect(db.log.map((entry) => entry.table)).toEqual(['marketing_suppressions']);
  });

  it.each(['GET', 'POST'] as const)('API-E3E78AD03D61 a %s with one inbox\'s link and another inbox\'s address is refused and changes neither', async (method) => {
    const before = suppressions();
    const response = await click(method, BOB, await tokenFor(ALICE), { ip: '203.0.113.23' });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('This unsubscribe link is invalid or has expired.');
    expect(suppressions()).toEqual(before);
    expect(db.log).toEqual([]);
  });

  it('API-262A058A148E a link for an inbox that already has a bounce or complaint row keeps it suppressed', async () => {
    const response = await click('POST', BOB, await tokenFor(BOB), { ip: '203.0.113.24' });
    expect(response.status).toBe(200);
    expect(db.table('marketing_suppressions').filter((row) => row.email === BOB)).toHaveLength(1);
  });

  it('API-E3E78AD03D61 the 31st click from one address in a minute is 429 with Retry-After and writes nothing', async () => {
    const token = await tokenFor(ALICE);
    for (let i = 0; i < 30; i++) expect((await click('GET', ALICE, token, { ip: '203.0.113.25' })).status).toBe(200);
    db.replace('marketing_suppressions', []);
    const refused = await click('GET', ALICE, token, { ip: '203.0.113.25' });
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(db.table('marketing_suppressions')).toEqual([]);
  });

  it('API-262A058A148E a durable limiter that cannot answer fails closed and writes nothing', async () => {
    h.limiterDown = true;
    const response = await click('POST', ALICE, await tokenFor(ALICE), { ip: '203.0.113.26' });
    expect(response.status).toBe(429);
    expect(suppressions()).toEqual([{ email: BOB, reason: 'complaint' }]);
  });

  it('API-262A058A148E with no signing secret in production a link is answered 503 "not configured", and nothing is written', async () => {
    const token = await tokenFor(ALICE);
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('MARKETING_UNSUB_SECRET', '');
    vi.stubEnv('INTERNAL_SECRET', '');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
    // No forwarded address, so the limiter key carries no IP to digest.
    const response = await click('POST', ALICE, token, { ip: null });
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('The unsubscribe service is not configured yet.');
    expect(suppressions()).toEqual([{ email: BOB, reason: 'complaint' }]);
  });

  it('API-262A058A148E a failed canonical-inbox write for an alias is 503 that does not claim the opt-out or leak the error', async () => {
    const alias = 'alice+news@example.com';
    let suppressionWrites = 0;
    h.db = withFaults(primaryKeyUpserts(db), (table, calls) => {
      if (table !== 'marketing_suppressions') return null;
      suppressionWrites += 1;
      return calls.some((call) => call.method === 'insert') ? { code: '42501', message: PRIVATE_DETAIL } : null;
    });
    const response = await click('POST', alias, await tokenFor(alias), { ip: '203.0.113.27' });
    const html = await response.text();
    expect(response.status).toBe(503);
    expect(html).toContain('may still receive marketing email');
    expect(html).not.toContain('will no longer receive');
    expect(html).not.toContain(PRIVATE_DETAIL);
    expect(suppressionWrites).toBe(2);
  });

  it('API-E3E78AD03D61 an address with markup is escaped in the confirmation page', async () => {
    const odd = '<img src=x onerror=alert(1)>@example.com';
    const response = await click('GET', odd, await tokenFor(odd), { ip: '203.0.113.28' });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;@example.com');
  });
});
