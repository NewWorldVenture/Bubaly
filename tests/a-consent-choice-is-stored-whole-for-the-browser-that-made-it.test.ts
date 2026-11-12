// API-2C772F6CE84C (POST) and API-E172ED0D13F4 (GET) — /api/mkt/consent,
// request level.
//
// The public cookie-banner ledger. Service-role over mkt_consent_events (RLS on,
// no policies), so the route is the only door; whose ledger is read or written
// is the `bubaly_vid` cookie, never a caller-chosen id (SEC-006). No session is
// read, so a signed-in member is just another browser.
//
// Already proven elsewhere, and not repeated here:
//   tests/a-visitor-reads-and-writes-only-their-own-consent.test.ts — naming
//     another visitor (query or body) gets none of their state and writes
//     nothing to their ledger; the owner gets their own; no-store on both; a
//     client that throws answers 503 no-store (limiter mocked, hand-built
//     ledger).
//   tests/a-visit-is-recorded-only-against-the-browser-that-sent-it.test.ts —
//     the banner's choice after a cookie rotation lands on the new visitor.
//   tests/provider-request-body-boundaries.test.ts — the bounded body reader.
//
// Added here, over the in-memory database with the real limiter: the exact rows
// a POST writes (policy version, trimmed source, GPC, truncated user agent, a
// `necessary` denial never stored) and the state read back from them; GET's
// state with and without GPC; a signed-in member of any role gets the same and
// no session is read; another browser's rows unchanged by a write from this
// one; the 30/60-a-minute limits refusing before any write; and a write that
// landed followed by a failed read answered 503, not a success.
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';
import { rateLimitHit } from './helpers/rate-limit-rpc';

const h = vi.hoisted(() => ({ db: null as unknown, createServer: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db, createServer: h.createServer }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

const MINE = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const THEIRS = '9f8b2c11-1d2e-4a3b-8c4d-5e6f70819a2b';
const FAMILY_A = '4a000000-0000-4000-8000-00000000000a';
const ROLES = ['parent', 'adult', 'teen', 'child', 'caregiver', 'guest'] as const;
const PRIVATE_DETAIL = 'mkt_consent_events internal statement detail';

let db: InMemorySupabase;

beforeEach(() => {
  vi.resetModules();
  h.createServer.mockReset();
  db = createInMemorySupabase({ rpc: { rate_limit_hit: rateLimitHit } });
  db.seed('mkt_consent_events', [
    { anonymous_id: THEIRS, category: 'analytics', decision: 'denied', created_at: '2026-01-01T00:00:00.000Z' },
    { anonymous_id: THEIRS, category: 'marketing_email', decision: 'granted', created_at: '2026-01-01T00:00:01.000Z' },
  ]);
  db.seed('family_members', [{ family_id: FAMILY_A, user_id: 'user-a', role: 'parent', is_active: true, display_name: 'Parent A' }]);
  h.db = db;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); });

function headers(ip: string, visitor?: string, extra: Record<string, string> = {}) {
  const out: Record<string, string> = { 'x-forwarded-for': ip, ...extra };
  const cookies = [visitor ? `bubaly_vid=${visitor}` : null, extra.cookie ?? null].filter(Boolean);
  if (cookies.length) out.cookie = cookies.join('; ');
  return out;
}
async function post(body: unknown, ip: string, visitor?: string, extra: Record<string, string> = {}) {
  const request = new NextRequest('https://bubaly.example/api/mkt/consent', {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers(ip, visitor, extra) }, body: JSON.stringify(body),
  });
  return (await import('@/app/api/mkt/consent/route')).POST(request);
}
async function get(query: string, ip: string, visitor?: string, extra: Record<string, string> = {}) {
  const request = new NextRequest(`https://bubaly.example/api/mkt/consent${query}`, { method: 'GET', headers: headers(ip, visitor, extra) });
  return (await import('@/app/api/mkt/consent/route')).GET(request);
}

const ledgerOf = (visitor: string) => db.table('mkt_consent_events').filter((row) => row.anonymous_id === visitor);
const DEFAULTS = { necessary: true, analytics: true, personalization: false, marketing_email: false, marketing_sms: false };

describe('API-2C772F6CE84C POST /api/mkt/consent', () => {
  it('API-2C772F6CE84C a signed-out choice appends one versioned row per decided category and answers the state read back', async () => {
    const response = await post(
      { consents: { analytics: false, personalization: true, necessary: false }, source: '  preference-center  ', gpc: true },
      '203.0.113.30', MINE, { 'user-agent': `Agent/${'x'.repeat(400)}` },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      ok: true,
      state: { necessary: true, analytics: false, personalization: true, marketing_email: false, marketing_sms: false },
    });
    const rows = ledgerOf(MINE).map(({ category, decision, policy_version, source, gpc, user_agent, contact_id }) => (
      { category, decision, policy_version, source, gpc, ua: String(user_agent).length, contact_id }));
    expect(rows).toEqual([
      { category: 'analytics', decision: 'denied', policy_version: 'v1', source: 'preference-center', gpc: true, ua: 300, contact_id: null },
      { category: 'personalization', decision: 'granted', policy_version: 'v1', source: 'preference-center', gpc: true, ua: 300, contact_id: null },
    ]);
  });

  it('API-2C772F6CE84C a blank or missing source is recorded as the banner', async () => {
    await post({ consents: { analytics: true }, source: '   ' }, '203.0.113.31', MINE);
    await post({ consents: { marketing_sms: false } }, '203.0.113.31', MINE);
    expect(ledgerOf(MINE).map((row) => row.source)).toEqual(['banner', 'banner']);
  });

  it.each(ROLES)('API-2C772F6CE84C a signed-in %s is one more browser: same rows, no session read, no household table touched', async (role) => {
    db.table('family_members')[0].role = role;
    const response = await post({ consents: { analytics: false } }, '203.0.113.32', MINE, { cookie: 'sb-bubaly-auth-token=member-session' });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain('Parent A');
    expect(h.createServer).not.toHaveBeenCalled();
    expect(new Set(db.log.map((entry) => entry.table))).toEqual(new Set(['mkt_consent_events']));
    expect(ledgerOf(MINE).map((row) => [row.category, row.decision])).toEqual([['analytics', 'denied']]);
  });

  it('API-2C772F6CE84C a write from this browser leaves another browser\'s ledger as it was, and naming it is refused', async () => {
    const before = structuredClone(ledgerOf(THEIRS));
    expect((await post({ consents: { marketing_email: false, analytics: true } }, '203.0.113.33', MINE)).status).toBe(200);
    const named = await post({ anonymousId: THEIRS, consents: { marketing_sms: true } }, '203.0.113.33', MINE);
    expect(named.status).toBe(403);
    expect(await named.json()).toEqual({ error: 'consent.notThisVisitor' });
    expect(ledgerOf(THEIRS)).toEqual(before);
    expect(ledgerOf(MINE).map((row) => row.category)).toEqual(['marketing_email', 'analytics']);
  });

  it('API-2C772F6CE84C without the visitor cookie nothing is written', async () => {
    const response = await post({ consents: { analytics: false } }, '203.0.113.34');
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'consent.visitorCookieRequired' });
    expect(db.table('mkt_consent_events')).toHaveLength(2);
  });

  it('API-2C772F6CE84C the 31st choice from one address in a minute is 429 with Retry-After and writes nothing', async () => {
    for (let i = 0; i < 30; i++) expect((await post({ consents: { analytics: true } }, '203.0.113.35', MINE)).status).toBe(200);
    const refused = await post({ consents: { analytics: false } }, '203.0.113.35', MINE);
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(ledgerOf(MINE)).toHaveLength(30);
    expect(ledgerOf(MINE).every((row) => row.decision === 'granted')).toBe(true);
  });

  it('API-2C772F6CE84C a write that landed followed by a failed state read is 503, not a success built on a default state', async () => {
    h.db = withFaults(db, (table, calls) => (
      table === 'mkt_consent_events' && calls.some((call) => call.method === 'select') ? { code: '57014', message: PRIVATE_DETAIL } : null));
    const response = await post({ consents: { analytics: false } }, '203.0.113.36', MINE);
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ error: 'consent.consentIsTemporarilyUnavailablePlease' });
    expect(text).not.toContain(PRIVATE_DETAIL);
  });

  it('API-2C772F6CE84C a refused insert is 503 and no state is returned', async () => {
    h.db = withFaults(db, (table, calls) => (
      table === 'mkt_consent_events' && calls.some((call) => call.method === 'insert') ? { code: '42501', message: PRIVATE_DETAIL } : null));
    const response = await post({ consents: { analytics: false } }, '203.0.113.37', MINE);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('state');
    expect(ledgerOf(MINE)).toEqual([]);
  });
});

describe('API-E172ED0D13F4 GET /api/mkt/consent', () => {
  it('API-E172ED0D13F4 a signed-out browser reads its own resolved state, and GPC switches off what it never decided', async () => {
    db.seed('mkt_consent_events', [
      { anonymous_id: MINE, category: 'marketing_sms', decision: 'granted', created_at: '2026-02-01T00:00:00.000Z' },
      { anonymous_id: MINE, category: 'personalization', decision: 'denied', created_at: '2026-02-01T00:00:01.000Z' },
      { anonymous_id: MINE, category: 'personalization', decision: 'granted', created_at: '2026-02-01T00:00:02.000Z' },
    ]);
    const plain = await get('', '203.0.113.40', MINE);
    expect(plain.status).toBe(200);
    expect(plain.headers.get('cache-control')).toBe('no-store');
    // The latest personalization decision wins; analytics was never decided, so it is on by default.
    expect(await plain.json()).toEqual({ ok: true, state: { ...DEFAULTS, analytics: true, personalization: true, marketing_sms: true } });
    // GPC turns off analytics, which was never decided, and leaves the explicit choices standing.
    const gpc = await get('?gpc=1', '203.0.113.40', MINE);
    expect(await gpc.json()).toEqual({ ok: true, state: { ...DEFAULTS, analytics: false, personalization: true, marketing_sms: true } });
    expect(ledgerOf(MINE)).toHaveLength(3);
  });

  it('API-E172ED0D13F4 a browser with no history gets the defaults, never another browser\'s choices', async () => {
    const response = await get('', '203.0.113.41', MINE);
    expect(await response.json()).toEqual({ ok: true, state: DEFAULTS });
  });

  it.each(ROLES)('API-E172ED0D13F4 a signed-in %s reads only the cookie\'s ledger and no session', async (role) => {
    db.table('family_members')[0].role = role;
    const response = await get('', '203.0.113.42', THEIRS, { cookie: 'sb-bubaly-auth-token=member-session' });
    expect(await response.json()).toEqual({ ok: true, state: { ...DEFAULTS, analytics: false, marketing_email: true } });
    expect(h.createServer).not.toHaveBeenCalled();
    expect(new Set(db.log.map((entry) => entry.table))).toEqual(new Set(['mkt_consent_events']));
  });

  it('API-E172ED0D13F4 without the visitor cookie it is 400 and reads no ledger', async () => {
    const response = await get(`?anonymousId=${THEIRS}`, '203.0.113.43');
    expect(response.status).toBe(400);
    expect(db.log).toEqual([]);
  });

  it('API-E172ED0D13F4 the 61st read from one address in a minute is 429 and reads nothing more', async () => {
    for (let i = 0; i < 60; i++) expect((await get('', '203.0.113.44', MINE)).status).toBe(200);
    const reads = db.log.length;
    const refused = await get('', '203.0.113.44', MINE);
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(db.log.length).toBe(reads);
  });

  it('API-E172ED0D13F4 a failed read is 503 no-store that carries no state and no internal detail', async () => {
    h.db = withFaults(db, (table) => (table === 'mkt_consent_events' ? { code: '57014', message: PRIVATE_DETAIL } : null));
    const response = await get('', '203.0.113.45', THEIRS);
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const text = await response.text();
    expect(text).not.toContain('state');
    expect(text).not.toContain(PRIVATE_DETAIL);
  });
});
