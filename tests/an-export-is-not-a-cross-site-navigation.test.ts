// GET /api/privacy/export answers the Privacy Center's fetch, not a navigation.
//
// The route sits behind SameSite=Lax cookies, and middleware applies no origin
// check to /api GETs, so any page the signed-in person visited could run
// `location.href = 'https://<app>/api/privacy/export'`: a top-level navigation
// sends the auth cookies and the route ran as the victim — a `privacy`/`export`
// row in trust_audit_logs attributed to their member, a spend of their 5/min
// budget (five navigations: 429 for the real export), and the browser saving
// bubaly-export-<family>-<date>.json unprompted onto whatever machine they were
// signed in on. The attacker reads nothing; those effects were the harm.
//
// The only legitimate caller is privacy-center.tsx's fetch, which the browser
// marks Sec-Fetch-Site: same-origin, Sec-Fetch-Mode: cors, Sec-Fetch-Dest:
// empty. A navigation, or another site's request, is refused BEFORE the rate
// limit and the ledger write; a browser too old to send fetch metadata is
// allowed only when its Referer names this host.
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import type { UserContext } from '@/lib/supabase/auth';

const mocks = vi.hoisted(() => ({ getUserContext: vi.fn(), createServer: vi.fn(), ledgerWriter: vi.fn(), budget: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({ getUserContext: mocks.getUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.createServer }));
vi.mock('@/lib/trust/ledger', () => ({ ledgerWriter: mocks.ledgerWriter }));

import { GET } from '@/app/api/privacy/export/route';

const FAMILY = 'fam-1';
const APP = 'https://app.example.invalid';
let db: InMemorySupabase;
let warnings: unknown[][];

const request = (headers: Record<string, string>) => new NextRequest(`${APP}/api/privacy/export`, { headers: { host: 'app.example.invalid', cookie: 'sb-app-auth-token=synthetic-session', ...headers } });

// How browsers mark each shape of request.
const PRIVACY_CENTER_FETCH = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty', accept: 'application/json', referer: `${APP}/dashboard/settings` };
const ATTACKER_NAVIGATION = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', accept: 'text/html,application/xhtml+xml', referer: 'https://evil.example/win-a-prize' };
const ADDRESS_BAR = { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', accept: 'text/html' };
const ATTACKER_FETCH = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty', origin: 'https://evil.example' };
const SIBLING_SUBDOMAIN = { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty', origin: 'https://blog.example.invalid' };
const OLD_BROWSER_SAME_ORIGIN = { accept: 'application/json', referer: `${APP}/dashboard/settings` };
const OLD_BROWSER_FROM_ATTACKER = { accept: 'text/html', referer: 'https://evil.example/' };

const ctx = {
  user: { id: 'user-parent', email: 'parent@example.com' }, memberships: [],
  active: { familyId: FAMILY, role: 'parent', member: { id: 'mem-parent' }, family: { id: FAMILY, name: 'The Riveras', timezone: 'UTC' } },
} as unknown as UserContext;

beforeEach(() => {
  warnings = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warnings.push(args); });
  mocks.budget.mockReset().mockReturnValue([{ allowed: true, retry_after: 0 }]);
  db = createInMemorySupabase({ userId: 'user-parent', rpc: { rate_limit_hit: (args) => mocks.budget(args) } });
  Object.assign(db.auth, {
    getSession: async () => ({ data: { session: { access_token: 'synthetic-assurance-token' } }, error: null }),
    mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null }) },
  });
  db.seed('families', [{ id: FAMILY, name: 'The Riveras', timezone: 'UTC' }]);
  db.seed('family_members', [{ id: 'mem-parent', family_id: FAMILY, user_id: 'user-parent', display_name: 'Jordan', role: 'parent', is_active: true, birthday: null, color: null, avatar_url: null }]);
  mocks.getUserContext.mockReset().mockResolvedValue(ctx);
  mocks.createServer.mockReset().mockResolvedValue(db);
  mocks.ledgerWriter.mockReset().mockImplementation(async (fallback: unknown) => fallback);
});
afterEach(() => vi.restoreAllMocks());

const refused = async (headers: Record<string, string>) => {
  const res = await GET(request(headers));
  expect(res.status).toBe(403);
  expect(res.headers.get('Cache-Control')).toBe('no-store');
  expect(res.headers.get('Content-Disposition')).toBeNull();
  expect(await res.json()).toEqual({ error: 'cross_site_request' });
  return res;
};

describe('a request that is not the Privacy Center\'s fetch', () => {
  it('a navigation forced by another page is refused before anything runs: no session read, no budget spent, no ledger row, no file', async () => {
    await refused(ATTACKER_NAVIGATION);
    expect(mocks.getUserContext).not.toHaveBeenCalled();
    expect(mocks.budget).not.toHaveBeenCalled();
    expect(db.table('trust_audit_logs')).toEqual([]);
    expect(db.log, 'no table was read for it').toEqual([]);
    // Logged, with the fetch metadata and nothing about the person.
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0][0])).toContain('[privacy] export refused');
  });

  it('the address bar, a bookmark, a cross-site fetch and a sibling subdomain are refused the same way', async () => {
    for (const headers of [ADDRESS_BAR, ATTACKER_FETCH, SIBLING_SUBDOMAIN]) await refused(headers);
    expect(mocks.getUserContext).not.toHaveBeenCalled();
    expect(db.table('trust_audit_logs')).toEqual([]);
  });

  it('five forced navigations leave the budget whole, so the real export still goes through', async () => {
    for (let i = 0; i < 5; i++) await refused(ATTACKER_NAVIGATION);
    expect(mocks.budget).not.toHaveBeenCalled();
    const real = await GET(request(PRIVACY_CENTER_FETCH));
    expect(real.status).toBe(200);
    expect(mocks.budget).toHaveBeenCalledTimes(1);
    expect(db.table('trust_audit_logs')).toHaveLength(1);
  });

  it('a browser with no fetch metadata is refused when its Referer is another site, or missing', async () => {
    await refused(OLD_BROWSER_FROM_ATTACKER);
    await refused({ accept: 'application/json' });
    expect(mocks.getUserContext).not.toHaveBeenCalled();
  });
});

describe('the Privacy Center\'s own fetch', () => {
  it('is answered with the file and recorded, as before', async () => {
    const res = await GET(request(PRIVACY_CENTER_FETCH));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toMatch(/^attachment; filename="bubaly-export-the-riveras-/);
    expect(db.table('trust_audit_logs')).toHaveLength(1);
    expect(db.table('trust_audit_logs')[0]).toMatchObject({ actor_id: 'mem-parent', domain: 'privacy', capability: 'export' });
    expect(warnings).toEqual([]);
  });

  it('from a browser too old for fetch metadata, whose Referer names this host, is still answered', async () => {
    const res = await GET(request(OLD_BROWSER_SAME_ORIGIN));
    expect(res.status).toBe(200);
    expect(db.table('trust_audit_logs')).toHaveLength(1);
  });

  it('behind a proxy, the forwarded host is the one the Referer is held to', async () => {
    const res = await GET(new NextRequest('http://10.0.0.5/api/privacy/export', {
      headers: { host: '10.0.0.5', 'x-forwarded-host': 'app.example.invalid', accept: 'application/json', referer: `${APP}/dashboard/settings` },
    }));
    expect(res.status).toBe(200);
  });
});
