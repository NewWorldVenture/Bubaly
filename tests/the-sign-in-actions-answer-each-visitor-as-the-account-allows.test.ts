// Call-level role tests for app/(auth)/actions.ts (audit Register B, group 8).
//
// These are sign-in actions, so "role" is who is calling: a signed-out visitor,
// a kid login of household A or of household B, a signed-in member of A in
// each role, a person with no household yet, and a super admin.
//
//  - childSignInAction resolves a username to ITS OWN child account and signs
//    that account in only with that account's derived password. It never reads
//    the caller's cookie session, so whoever is signed in on the device does
//    not change the answer. A removed child (inactive membership) and a
//    child_logins row whose member is not that account are refused with the
//    same words as a wrong PIN. A kid login may be held by any non-manager
//    role (rolesForAKidLogin, lib/constants/roles.ts:88), so a teen's kid
//    login signs in like a child's. The password provider is the only seam:
//    @supabase/supabase-js gets a fetch that knows each account's password.
//  - resolveLandingPathAction: super admins land on /admin, a guest on the
//    Grandparent Portal, every other role and every caller without a
//    household on /home (lib/auth/landing.ts).
//  - stitchIdentityAction links THIS browser's anonymous visitor row to the
//    signed-in account's own contact, never to another person's: a visitor
//    row that already belongs to household B's parent is left alone and the
//    browser gets a fresh anonymous id. A kid login or a teen account is not
//    pinned here (owner decision, see the PR body).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { rateLimitHit } from './helpers/rate-limit-rpc';
import { deriveChildPassword } from '@/lib/onboarding/child-password';
import { syntheticChildEmail } from '@/lib/onboarding/child-login';

const h = vi.hoisted(() => ({
  db: null as unknown,
  epoch: 0,
  sessionUser: null as null | { id: string; email?: string },
  jar: new Map<string, string>(),
  setCookie: vi.fn(),
  createServer: vi.fn(),
  getUserContext: vi.fn(),
  isSuperAdmin: vi.fn(),
  signIns: [] as Array<{ email: string; password: string }>,
  receiptSub: null as null | string,
}));

vi.mock('@/lib/server/rate-limit', async (original) => {
  const real = await original<typeof import('@/lib/server/rate-limit')>();
  return { ...real, rateLimit: (key: string, opts?: Parameters<typeof real.rateLimit>[1]) => real.rateLimit(`${h.epoch}:${key}`, opts) };
});
vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-forwarded-for': '203.0.113.20' }),
  cookies: async () => ({
    get: (name: string) => (h.jar.has(name) ? { name, value: h.jar.get(name)! } : undefined),
    set: (name: string, value: string, options: unknown) => { h.setCookie(name, value, options); h.jar.set(name, value); },
  }),
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({ getUserContext: h.getUserContext, isSuperAdmin: h.isSuperAdmin }));
vi.mock('@/lib/supabase/server', () => ({ createServer: h.createServer, createServiceClient: () => h.db }));
vi.mock('@supabase/supabase-js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@supabase/supabase-js')>();
  return {
    ...actual,
    createClient: (url: string, key: string, options: Parameters<typeof actual.createClient>[2]) =>
      actual.createClient(url, key, { ...options, global: { ...options?.global, fetch: provider } }),
  };
});

const SECRET = 'synthetic-child-secret-for-tests';
const FAMILY_A = 'a0000000-0000-4000-8000-00000000000a';
const FAMILY_B = 'b0000000-0000-4000-8000-00000000000b';
const KID_A = { user: 'a0000000-0000-4000-8000-0000000003a1', member: 'a0000000-0000-4000-8000-0000000004a1', username: 'kidafixture', pin: '2468', role: 'child' };
const TEEN_A = { user: 'a0000000-0000-4000-8000-0000000003a2', member: 'a0000000-0000-4000-8000-0000000004a2', username: 'teenafixture', pin: '1357', role: 'teen' };
const KID_B = { user: 'b0000000-0000-4000-8000-0000000003b1', member: 'b0000000-0000-4000-8000-0000000004b1', username: 'kidbfixture', pin: '9753', role: 'child' };
const B_PARENT = 'b0000000-0000-4000-8000-0000000000b1';
const KIDS = [KID_A, TEEN_A, KID_B];

/** The password grant, as GoTrue answers it: only an account's own derived password signs it in. */
async function provider(_url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const { email, password } = JSON.parse(String(init?.body));
  h.signIns.push({ email, password });
  const account = KIDS.find((k) => syntheticChildEmail(k.username) === email && deriveChildPassword(SECRET, k.username, k.pin) === password);
  if (!account) {
    return new Response(JSON.stringify({ error_code: 'invalid_credentials', msg: 'Invalid login credentials' }), { status: 400, headers: { 'content-type': 'application/json' } });
  }
  const token = [Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'),
    Buffer.from(JSON.stringify({ sub: h.receiptSub ?? account.user, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url'), 'sig'].join('.');
  return new Response(JSON.stringify({
    access_token: token, refresh_token: `fake-refresh-${account.username}`, token_type: 'bearer', expires_in: 3600,
    user: { id: account.user, email, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-09-01T00:00:00Z' },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

const { childSignInAction, resolveLandingPathAction, stitchIdentityAction } = await import('@/app/(auth)/actions');

let db: InMemorySupabase;
const throttle = (username: string) => db.table('child_login_throttle').find((r) => r.username === username);
const subOf = (token: string) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub;

beforeEach(() => {
  vi.stubEnv('CHILD_LOGIN_SECRET', SECRET);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://sign-in-fixture.example.com');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'fake-public-anon');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  h.epoch++;
  h.jar.clear();
  h.signIns = [];
  h.sessionUser = null;
  h.receiptSub = null;
  h.setCookie.mockReset();
  h.getUserContext.mockReset();
  h.isSuperAdmin.mockReset().mockResolvedValue(false);
  h.createServer.mockReset().mockImplementation(async () => ({ auth: { getUser: async () => ({ data: { user: h.sessionUser }, error: null }) } }));
  db = createInMemorySupabase({ uniques: { child_login_throttle: [['username']] }, rpc: { rate_limit_hit: rateLimitHit } });
  h.db = db;
  db.seed('child_logins', KIDS.map((k) => ({ user_id: k.user, member_id: k.member, family_id: k === KID_B ? FAMILY_B : FAMILY_A, username: k.username })));
  db.seed('family_members', KIDS.map((k) => ({ id: k.member, user_id: k.user, family_id: k === KID_B ? FAMILY_B : FAMILY_A, role: k.role, is_active: true })));
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('childSignInAction signs in only the account the username names', () => {
  it.each([['a child of A', KID_A], ['a teen of A with a kid login', TEEN_A], ['a child of B', KID_B]])(
    'ACTION-BBDAE32AD14B %s signs in with their own PIN, as themselves, and leaves a clean slate', async (_label, kid) => {
      const result = await childSignInAction({ username: kid.username, pin: kid.pin });
      expect(result.ok).toBe(true);
      expect(result.ok && subOf(result.tokens.access_token)).toBe(kid.user);
      expect(result.ok && result.tokens.refresh_token).toBe(`fake-refresh-${kid.username}`);
      expect(throttle(kid.username)).toMatchObject({ fails: 0, locked_until: null });
      expect(db.table('child_login_throttle')).toHaveLength(1);
      // The device's own session is never consulted.
      expect(h.createServer).not.toHaveBeenCalled();
    });

  it("ACTION-BBDAE32AD14B a signed-in parent on the device does not change whose account a username opens", async () => {
    h.sessionUser = { id: B_PARENT, email: 'parent-b@example.com' };
    const result = await childSignInAction({ username: KID_A.username, pin: KID_A.pin });
    expect(result.ok && subOf(result.tokens.access_token)).toBe(KID_A.user);
    expect(h.createServer).not.toHaveBeenCalled();
  });

  it("ACTION-BBDAE32AD14B household A's PIN does not open household B's child, and B's PIN does not open A's", async () => {
    await expect(childSignInAction({ username: KID_B.username, pin: KID_A.pin })).resolves.toEqual({ ok: false, error: 'actions.thatUsernameOrPinIsn' });
    await expect(childSignInAction({ username: KID_A.username, pin: KID_B.pin })).resolves.toEqual({ ok: false, error: 'actions.thatUsernameOrPinIsn' });
    // Each miss is counted against the username that was typed.
    expect(throttle(KID_B.username)).toMatchObject({ fails: 1 });
    expect(throttle(KID_A.username)).toMatchObject({ fails: 1 });
  });

  it('ACTION-BBDAE32AD14B a child removed from household A is refused with the wrong-PIN words, and no real password is offered', async () => {
    db.table('family_members').find((m) => m.id === KID_A.member)!.is_active = false;
    await expect(childSignInAction({ username: KID_A.username, pin: KID_A.pin })).resolves.toEqual({ ok: false, error: 'actions.thatUsernameOrPinIsn' });
    expect(h.signIns).toHaveLength(1);
    expect(h.signIns[0].password).not.toBe(deriveChildPassword(SECRET, KID_A.username, KID_A.pin));
    expect(throttle(KID_A.username)).toMatchObject({ fails: 1 });
  });

  it("ACTION-BBDAE32AD14B a login row pointing at household B's member, not its own account's, is refused", async () => {
    // A's login row now names B's child's membership: the member/account pair does not match.
    db.table('child_logins').find((r) => r.username === KID_A.username)!.member_id = KID_B.member;
    await expect(childSignInAction({ username: KID_A.username, pin: KID_A.pin })).resolves.toEqual({ ok: false, error: 'actions.thatUsernameOrPinIsn' });
    expect(h.signIns[0].password).not.toBe(deriveChildPassword(SECRET, KID_A.username, KID_A.pin));
  });

  it("ACTION-BBDAE32AD14B a receipt whose token names household B's child is not handed to household A's child", async () => {
    // The provider accepts A's child's password but the access token it
    // returns carries B's child as its subject: an inconsistent receipt.
    h.receiptSub = KID_B.user;
    await expect(childSignInAction({ username: KID_A.username, pin: KID_A.pin })).resolves.toEqual({ ok: false, error: 'actions.kidSignInIsTemporarily' });
  });

  it('ACTION-BBDAE32AD14B an unknown username is refused the same way', async () => {
    await expect(childSignInAction({ username: 'nobodyfixture', pin: '1111' })).resolves.toEqual({ ok: false, error: 'actions.thatUsernameOrPinIsn' });
    expect(throttle('nobodyfixture')).toMatchObject({ fails: 1 });
  });

  it('ACTION-BBDAE32AD14B a wildcard spelling of a real username does not open it', async () => {
    const spelled = `${KID_A.username.slice(0, 2)}_${KID_A.username.slice(3)}`;
    await expect(childSignInAction({ username: spelled, pin: KID_A.pin })).resolves.toEqual({ ok: false, error: 'actions.thatUsernameOrPinIsn' });
  });
});

describe('resolveLandingPathAction answers each role', () => {
  const ctxFor = (role: string) => ({ user: { id: 'a0000000-0000-4000-8000-000000000101' }, memberships: [], active: { familyId: FAMILY_A, role } });

  it.each(['parent', 'adult', 'teen', 'child', 'caregiver'])('ACTION-E6AC69DF9AEB a %s lands on /home', async (role) => {
    h.getUserContext.mockResolvedValue(ctxFor(role));
    await expect(resolveLandingPathAction()).resolves.toBe('/home');
  });

  it('ACTION-E6AC69DF9AEB a guest lands on the Grandparent Portal', async () => {
    h.getUserContext.mockResolvedValue(ctxFor('guest'));
    await expect(resolveLandingPathAction()).resolves.toBe('/dashboard/grandparent-portal');
  });

  it('ACTION-E6AC69DF9AEB a super admin lands on /admin whatever their household role', async () => {
    h.isSuperAdmin.mockResolvedValue(true);
    h.getUserContext.mockResolvedValue(ctxFor('guest'));
    await expect(resolveLandingPathAction()).resolves.toBe('/admin');
  });

  it('ACTION-E6AC69DF9AEB a person with no household, a signed-out caller and a failed lookup land on /home', async () => {
    h.getUserContext.mockResolvedValueOnce({ user: { id: 'c0000000-0000-4000-8000-0000000000c1' }, needsFamily: true });
    await expect(resolveLandingPathAction()).resolves.toBe('/home');
    h.getUserContext.mockResolvedValueOnce(null);
    await expect(resolveLandingPathAction()).resolves.toBe('/home');
    h.getUserContext.mockRejectedValueOnce(new Error('lookup failed'));
    await expect(resolveLandingPathAction()).resolves.toBe('/home');
  });
});

describe("stitchIdentityAction links this browser to the signed-in account's own contact", () => {
  const VID = 'visitor-fixture-0001';
  const contactOf = (ownerId: string) => db.table('crm_contacts').filter((c) => c.owner_id === ownerId);

  function seedSpine() {
    h.jar.set('bubaly_vid', VID);
    db.seed('mkt_visitors', [{ id: 'f0000000-0000-4000-8000-0000000000f1', anonymous_id: VID, contact_id: null }]);
    db.seed('mkt_consent_events', [{ id: 'f0000000-0000-4000-8000-0000000000e1', anonymous_id: VID, contact_id: null, kind: 'analytics' }]);
    db.seed('crm_contacts', [{ id: 'b0000000-0000-4000-8000-0000000005b1', email: 'parent-b@example.com', owner_id: B_PARENT, lifecycle_stage: 'customer' }]);
  }

  it.each(['parent', 'adult', 'caregiver', 'guest'])('ACTION-9FB724502062 a %s of A gets their own contact, linked to this browser', async (role) => {
    seedSpine();
    const userId = `a0000000-0000-4000-8000-0000000001${String(['parent', 'adult', 'caregiver', 'guest'].indexOf(role)).padStart(2, '0')}`;
    h.sessionUser = { id: userId, email: `${role}-a@example.com` };
    await expect(stitchIdentityAction()).resolves.toBeUndefined();
    const own = contactOf(userId);
    expect(own).toEqual([expect.objectContaining({ email: `${role}-a@example.com`, lifecycle_stage: 'customer' })]);
    expect(db.table('mkt_visitors')[0]).toMatchObject({ contact_id: own[0].id });
    expect(db.table('mkt_consent_events')[0]).toMatchObject({ contact_id: own[0].id });
    // Household B's contact is untouched, and the browser keeps its id.
    expect(contactOf(B_PARENT)).toEqual([expect.objectContaining({ email: 'parent-b@example.com', lifecycle_stage: 'customer' })]);
    expect(h.setCookie).not.toHaveBeenCalled();
  });

  it('ACTION-9FB724502062 a signed-out visitor, and an account with no email, write nothing', async () => {
    seedSpine();
    h.sessionUser = { id: 'a0000000-0000-4000-8000-000000000109' };
    await expect(stitchIdentityAction()).resolves.toBeUndefined();
    h.sessionUser = null;
    const before = JSON.stringify([db.table('crm_contacts'), db.table('mkt_visitors'), db.table('mkt_consent_events')]);
    await expect(stitchIdentityAction()).resolves.toBeUndefined();
    expect(JSON.stringify([db.table('crm_contacts'), db.table('mkt_visitors'), db.table('mkt_consent_events')])).toBe(before);
    expect(h.setCookie).not.toHaveBeenCalled();
  });

  it("ACTION-9FB724502062 a browser whose visitor row is household B's parent's is not taken over: it gets a fresh id", async () => {
    seedSpine();
    db.table('mkt_visitors')[0].contact_id = 'b0000000-0000-4000-8000-0000000005b1';
    const userId = 'a0000000-0000-4000-8000-000000000100';
    h.sessionUser = { id: userId, email: 'parent-a@example.com' };
    await expect(stitchIdentityAction()).resolves.toBeUndefined();
    expect(db.table('mkt_visitors')[0]).toMatchObject({ contact_id: 'b0000000-0000-4000-8000-0000000005b1' });
    expect(db.table('mkt_consent_events')[0]).toMatchObject({ contact_id: null });
    expect(contactOf(B_PARENT)).toEqual([expect.objectContaining({ email: 'parent-b@example.com' })]);
    expect(h.setCookie).toHaveBeenCalledTimes(1);
    expect(h.jar.get('bubaly_vid')).not.toBe(VID);
  });
});
