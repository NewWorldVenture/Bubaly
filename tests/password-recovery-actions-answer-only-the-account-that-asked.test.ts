// Call-level tests for app/(auth)/auth/recovery/actions.ts (audit Register B, group 8).
//
// Password recovery is ACCOUNT-scoped: no action here reads a household, a
// membership or a role, so a parent, a teen and a guest of household A are all
// "an account with a recovery session" and get the same answer. What the
// actions must hold is whose account they act on:
//  - the account whose recovery link opened this session (account A) gets a
//    grant, can inspect it and can save a new password, and that PUT carries
//    A's own token;
//  - another account's session on the same browser (account B, a member of
//    household B) cannot use A's grant, and A's grant never changes B's
//    password;
//  - a signed-out browser (no session cookie) and an ordinary password
//    session that did not come from a recovery link get nothing.
//
// Everything below the actions is the real code — lib/auth/recovery-server.ts
// and lib/auth/recovery-cookies.ts. The only seams are the request cookies and
// the Supabase Auth HTTP endpoints (JWKS, /user, /token), answered by a stub
// that signs tokens with a throwaway key. The password write IS the PUT to
// /auth/v1/user, so "what it wrote" is read back from that stub.
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ cookies: new Map<string, string>() }));
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (h.cookies.has(name) ? { name, value: h.cookies.get(name)! } : undefined),
    getAll: () => [...h.cookies].map(([name, value]) => ({ name, value })),
  }),
  headers: async () => new Headers(),
}));

const { consumeRecoveryAction, inspectRecoveryAction, prepareRecoveryAction, saveRecoveryAction } =
  await import('@/app/(auth)/auth/recovery/actions');

const ORIGIN = 'https://recovery-actions.supabase.co';
const SESSION_COOKIE = 'sb-recovery-actions-auth-token';
const HANDOFF_COOKIE = 'bubaly-recovery-handoff';
const ACCOUNT_A = 'a0000000-0000-4000-8000-0000000001a1';
const ACCOUNT_B = 'b0000000-0000-4000-8000-0000000001b1';
const SESSION_A = 'a0000000-0000-4000-8000-0000000005a1';
const SESSION_B = 'b0000000-0000-4000-8000-0000000005b1';
const NOW = Date.parse('2026-11-12T12:00:00Z');
const SECOND = NOW / 1000;
const NEW_PASSWORD = 'fake-new-password-123';

const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const publicJwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'recovery-actions-fixture', alg: 'ES256', use: 'sig' };
type Json = Record<string, unknown>;

function jwt(sub: string, sid: string, overrides: Json = {}): string {
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: publicJwk.kid, typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({
    iss: `${ORIGIN}/auth/v1`, aud: 'authenticated', role: 'authenticated', sub, session_id: sid,
    exp: SECOND + 3600, iat: SECOND, amr: [{ method: 'recovery', timestamp: SECOND - 60 }], ...overrides,
  })).toString('base64url');
  const sig = sign('sha256', Buffer.from(`${header}.${body}`), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' });
  return `${header}.${body}.${sig.toString('base64url')}`;
}
const claims = (token: string): Json => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
const emailOf = (id: string) => (id === ACCOUNT_A ? 'account-a@example.com' : 'account-b@example.com');

let puts: Array<{ bearer: string; sub: unknown; body: Json }>;
/** What the refresh grant answers with — A's own rotated token unless a case says otherwise. */
let refreshed: () => string;

async function provider(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : String(input));
  const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
  if (url.origin !== ORIGIN) throw new Error(`unexpected origin ${url.origin}`);
  if (url.pathname === '/auth/v1/.well-known/jwks.json') return Response.json({ keys: [publicJwk] });
  if (url.pathname === '/auth/v1/token') {
    const token = refreshed();
    return Response.json({ access_token: token, refresh_token: 'fake-rotated-refresh', token_type: 'bearer', expires_in: 3600, user: { id: claims(token).sub } });
  }
  if (url.pathname === '/auth/v1/user') {
    const bearer = headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
    const [hd, pl, sg] = bearer.split('.');
    if (!sg || !verify('sha256', Buffer.from(`${hd}.${pl}`), { key: keys.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sg, 'base64url'))) {
      return Response.json({ code: 'bad_jwt', message: 'invalid' }, { status: 401 });
    }
    const sub = String(claims(bearer).sub);
    if ((init.method ?? 'GET') === 'PUT') {
      puts.push({ bearer, sub, body: JSON.parse(String(init.body)) });
    }
    return Response.json({ id: sub, email: emailOf(sub), aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' });
  }
  throw new Error(`unexpected path ${url.pathname}`);
}

const recoveryTokenA = () => jwt(ACCOUNT_A, SESSION_A);
const sessionB = () => jwt(ACCOUNT_B, SESSION_B);
function browserSignedInWith(token: string | null) {
  h.cookies.delete(SESSION_COOKIE);
  if (token) h.cookies.set(SESSION_COOKIE, JSON.stringify({ access_token: token, refresh_token: 'fake-refresh', token_type: 'bearer' }));
}
/** Account A follows its recovery link: the real prepare action issues A's grant. */
async function grantForA(): Promise<string> {
  const prepared = await prepareRecoveryAction(recoveryTokenA(), 'fake-refresh-a');
  if (!prepared.ok) throw new Error(`fixture: prepare failed with ${prepared.errorKey}`);
  return prepared.grant;
}
const handoffFor = (grant: string) => createHash('sha256').update(grant).digest('hex');

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', ORIGIN);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'fake-public-anon');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'fake-service-key-for-recovery-tests');
  vi.stubGlobal('fetch', provider);
  h.cookies.clear();
  puts = [];
  refreshed = () => jwt(ACCOUNT_A, SESSION_A, { iat: SECOND + 1 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('prepareRecoveryAction', () => {
  it("ACTION-616ECD0B139E account A's own recovery link yields A's grant and A's rotated session", async () => {
    const result = await prepareRecoveryAction(recoveryTokenA(), 'fake-refresh-a');
    expect(result).toMatchObject({ ok: true, identity: { userId: ACCOUNT_A, sessionId: SESSION_A, email: 'account-a@example.com' } });
    expect(result.ok && claims(result.session.access_token).sub).toBe(ACCOUNT_A);
    expect(result.ok && typeof result.grant).toBe('string');
    expect(puts).toEqual([]);
  });

  it('ACTION-616ECD0B139E an ordinary password session (no recovery link) gets no grant', async () => {
    const passwordSession = jwt(ACCOUNT_A, SESSION_A, { amr: [{ method: 'password', timestamp: SECOND - 60 }] });
    await expect(prepareRecoveryAction(passwordSession, 'fake-refresh-a')).resolves.toEqual({ ok: false, errorKey: 'authRecovery.invalidLink' });
  });

  it("ACTION-616ECD0B139E a refresh token that rotates into account B's session is refused", async () => {
    refreshed = () => jwt(ACCOUNT_B, SESSION_B, { iat: SECOND + 1 });
    await expect(prepareRecoveryAction(recoveryTokenA(), 'fake-refresh-of-b')).resolves.toEqual({ ok: false, errorKey: 'authRecovery.sessionChanged' });
  });
});

describe('consumeRecoveryAction', () => {
  it("ACTION-C837852680A0 account A's browser, with A's bridge cookie and A's session, gets A's identity", async () => {
    const grant = await grantForA();
    h.cookies.set(HANDOFF_COOKIE, grant);
    browserSignedInWith(recoveryTokenA());
    await expect(consumeRecoveryAction(handoffFor(grant))).resolves.toMatchObject({ ok: true, identity: { userId: ACCOUNT_A }, grant });
  });

  it("ACTION-C837852680A0 account B's session cannot consume A's bridge", async () => {
    const grant = await grantForA();
    h.cookies.set(HANDOFF_COOKIE, grant);
    browserSignedInWith(sessionB());
    await expect(consumeRecoveryAction(handoffFor(grant))).resolves.toEqual({ ok: false, errorKey: 'authRecovery.sessionChanged' });
  });

  it('ACTION-C837852680A0 a signed-out browser is refused', async () => {
    const grant = await grantForA();
    h.cookies.set(HANDOFF_COOKIE, grant);
    browserSignedInWith(null);
    await expect(consumeRecoveryAction(handoffFor(grant))).resolves.toEqual({ ok: false, errorKey: 'authRecovery.sessionChanged' });
  });

  it('ACTION-C837852680A0 a handoff that is not the hash of the bridge cookie is refused', async () => {
    const grant = await grantForA();
    h.cookies.set(HANDOFF_COOKIE, grant);
    browserSignedInWith(recoveryTokenA());
    await expect(consumeRecoveryAction(handoffFor(`${grant}x`))).resolves.toEqual({ ok: false, errorKey: 'authRecovery.invalidLink' });
    h.cookies.delete(HANDOFF_COOKIE);
    await expect(consumeRecoveryAction(handoffFor(grant))).resolves.toEqual({ ok: false, errorKey: 'authRecovery.invalidLink' });
  });
});

describe('inspectRecoveryAction', () => {
  it("ACTION-F52FD7C3A46F account A's session inspects A's grant", async () => {
    const grant = await grantForA();
    browserSignedInWith(recoveryTokenA());
    await expect(inspectRecoveryAction(grant)).resolves.toMatchObject({ ok: true, identity: { userId: ACCOUNT_A, email: 'account-a@example.com' } });
  });

  it("ACTION-F52FD7C3A46F account B's session, or a signed-out browser, learns nothing from A's grant", async () => {
    const grant = await grantForA();
    browserSignedInWith(sessionB());
    await expect(inspectRecoveryAction(grant)).resolves.toEqual({ ok: false, errorKey: 'authRecovery.sessionChanged' });
    browserSignedInWith(null);
    await expect(inspectRecoveryAction(grant)).resolves.toEqual({ ok: false, errorKey: 'authRecovery.sessionChanged' });
  });

  it("ACTION-F52FD7C3A46F A's grant is bound to the recovery that issued it, not to any later sign-in of the same session", async () => {
    const grant = await grantForA();
    // Same account, same session id, but its recovery evidence is a different
    // sign-in than the one the grant was issued for.
    browserSignedInWith(jwt(ACCOUNT_A, SESSION_A, { amr: [{ method: 'otp', timestamp: SECOND - 10 }] }));
    await expect(inspectRecoveryAction(grant)).resolves.toEqual({ ok: false, errorKey: 'authRecovery.sessionChanged' });
  });

  it('ACTION-F52FD7C3A46F a grant with a forged signature is refused', async () => {
    const grant = await grantForA();
    const [payload] = grant.split('.');
    browserSignedInWith(recoveryTokenA());
    await expect(inspectRecoveryAction(`${payload}.${Buffer.alloc(32).toString('base64url')}`)).resolves.toEqual({ ok: false, errorKey: 'authRecovery.invalidLink' });
  });
});

describe('saveRecoveryAction', () => {
  it("ACTION-D9DE0BA020AA account A saves A's new password, with A's own token", async () => {
    const grant = await grantForA();
    const session = recoveryTokenA();
    browserSignedInWith(session);
    await expect(saveRecoveryAction(grant, NEW_PASSWORD)).resolves.toEqual({ outcome: 'updated' });
    expect(puts).toEqual([{ bearer: session, sub: ACCOUNT_A, body: { password: NEW_PASSWORD } }]);
  });

  it("ACTION-D9DE0BA020AA account B's session cannot use A's grant, and B's password is not written", async () => {
    const grant = await grantForA();
    browserSignedInWith(sessionB());
    await expect(saveRecoveryAction(grant, NEW_PASSWORD)).resolves.toEqual({ outcome: 'failed', errorKey: 'authRecovery.sessionChanged' });
    expect(puts).toEqual([]);
  });

  it('ACTION-D9DE0BA020AA a signed-out browser writes no password', async () => {
    const grant = await grantForA();
    browserSignedInWith(null);
    await expect(saveRecoveryAction(grant, NEW_PASSWORD)).resolves.toEqual({ outcome: 'failed', errorKey: 'authRecovery.sessionChanged' });
    expect(puts).toEqual([]);
  });

  it("ACTION-D9DE0BA020AA a password session of account A without a recovery link cannot use an old grant", async () => {
    const grant = await grantForA();
    browserSignedInWith(jwt(ACCOUNT_A, 'a0000000-0000-4000-8000-0000000005a9', { amr: [{ method: 'password', timestamp: SECOND - 30 }] }));
    const result = await saveRecoveryAction(grant, NEW_PASSWORD);
    expect(result.outcome).toBe('failed');
    expect(puts).toEqual([]);
  });
});
