import { createHmac, generateKeyPairSync, sign, verify } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRecoveryGrant, prepareImplicitRecovery, RecoveryError, updateRecoveryPassword, verifyRecoveryGrant } from '@/lib/auth/recovery-server';

const ORIGIN = 'https://recovery-server.supabase.co';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const SID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_SID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NOW = Date.parse('2026-09-12T20:00:00Z');
const SECOND = NOW / 1000;
const SECRET = 'synthetic-service-key-for-recovery-tests-only';
const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const publicJwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'recovery-fixture-key', alg: 'ES256', use: 'sig' };
type Json = Record<string, unknown>;
function jwt(overrides: Json = {}, validSignature = true): string {
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: publicJwk.kid, typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ iss: `${ORIGIN}/auth/v1`, aud: 'authenticated', role: 'authenticated', sub: A,
    session_id: SID, exp: SECOND + 3600, iat: SECOND, amr: [{ method: 'recovery', timestamp: SECOND }], ...overrides })).toString('base64url');
  const sig = sign('sha256', Buffer.from(`${header}.${body}`), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' });
  if (!validSignature) sig[0] ^= 1;
  return `${header}.${body}.${sig.toString('base64url')}`;
}
function claims(token: string): Json { return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()); }
function user(id = A) { return { id, email: id === A ? 'a@example.invalid' : 'b@example.invalid', aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' }; }
type Call = { url: URL; method: string; headers: Headers; body: Json | null; signal: AbortSignal | null | undefined };
let calls: Call[];
let token: string;
let refreshed: string;
let userOverride: string | null;
let responseOverride: ((call: Call) => Response | Promise<Response> | undefined) | undefined;
const provider = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', ` "${ORIGIN}" `);
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', " 'synthetic-public-anon' ");
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', ` '${SECRET}' `);
  token = jwt(); refreshed = jwt({ iat: SECOND + 1 }); calls = []; userOverride = null; responseOverride = undefined;
  provider.mockReset();
  provider.mockImplementation(async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init.headers ?? (input instanceof Request ? input.headers : undefined));
    const call: Call = { url, method: init.method ?? 'GET', headers, body: typeof init.body === 'string' ? JSON.parse(init.body) : null, signal: init.signal };
    calls.push(call);
    expect(url.origin).toBe(ORIGIN);
    expect(init.redirect).toBe('manual');
    expect(init.cache).toBe('no-store');
    expect(headers.get('apikey')).toBe('synthetic-public-anon');
    expect([...headers.values()].join(' ')).not.toContain(SECRET);
    const overridden = responseOverride?.(call);
    if (overridden) return overridden;
    if (url.pathname.endsWith('/.well-known/jwks.json')) return Response.json({ keys: [publicJwk] });
    if (url.pathname === '/auth/v1/token') return Response.json({ access_token: refreshed, refresh_token: 'rotated-refresh', token_type: 'bearer', expires_in: 3600, user: user(String(claims(refreshed).sub)) });
    if (url.pathname === '/auth/v1/user') {
      const bearer = headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
      const [h, p, s] = bearer.split('.');
      if (!s || !verify('sha256', Buffer.from(`${h}.${p}`), { key: keys.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'))) {
        return Response.json({ code: 'bad_jwt', message: 'private diagnostic' }, { status: 401 });
      }
      return Response.json(user(userOverride ?? String(claims(bearer).sub)));
    }
    throw new Error('Unexpected synthetic URL');
  });
  vi.stubGlobal('fetch', provider);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const puts = () => calls.filter(call => call.method === 'PUT');
const refreshes = () => calls.filter(call => call.url.pathname === '/auth/v1/token');

describe('verified recovery grant using the installed SDK and real synthetic signatures', () => {
  it.each(['recovery', 'otp'])('accepts verified fresh %s evidence and binds a secret-free grant', async method => {
    token = jwt({ amr: [{ method, timestamp: SECOND - 30 }] });
    const result = await createRecoveryGrant(token);
    expect(result.identity).toEqual({ userId: A, sessionId: SID, email: 'a@example.invalid', expiresAt: NOW - 30_000 + 900_000 });
    expect(await verifyRecoveryGrant(result.grant, token)).toEqual(result.identity);
    expect(calls.some(call => call.url.pathname.endsWith('/jwks.json'))).toBe(true);
    expect(calls.some(call => call.method === 'GET' && call.url.pathname.endsWith('/user'))).toBe(true);
    expect(result.grant).not.toContain(token);
    const contents = JSON.stringify(JSON.parse(Buffer.from(result.grant.split('.')[0], 'base64url').toString()));
    expect(contents).not.toMatch(/access_token|refresh_token|email|example\.invalid|synthetic-service/);
    expect(puts()).toHaveLength(0);
  });
  it('uses a distinct nonce and rejects a tampered signed payload', async () => {
    const first = await createRecoveryGrant(token); const second = await createRecoveryGrant(token);
    expect(first.grant).not.toBe(second.grant);
    const [payload, mac] = first.grant.split('.');
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString()); decoded.sub = B;
    await expect(verifyRecoveryGrant(`${Buffer.from(JSON.stringify(decoded)).toString('base64url')}.${mac}`, token)).rejects.toMatchObject({ key: 'authRecovery.invalidLink' });
  });
  it.each([
    { label: 'password only', fields: { amr: [{ method: 'password', timestamp: SECOND }] } },
    { label: 'missing AMR', fields: { amr: undefined } },
    { label: 'string AMR', fields: { amr: 'recovery' } },
    { label: 'string timestamp', fields: { amr: [{ method: 'recovery', timestamp: String(SECOND) }] } },
    { label: 'future AMR', fields: { amr: [{ method: 'recovery', timestamp: SECOND + 300 }] } },
    { label: 'wrong project', fields: { iss: 'https://other.supabase.co/auth/v1' } },
    { label: 'wrong audience', fields: { aud: 'service_role' } },
    { label: 'wrong role', fields: { role: 'service_role' } },
    { label: 'missing subject', fields: { sub: undefined } },
    { label: 'missing SID', fields: { session_id: undefined } },
    { label: 'malformed SID', fields: { session_id: 'not-a-session' } },
    { label: 'future issued time', fields: { iat: SECOND + 300 } },
    { label: 'future not-before', fields: { nbf: SECOND + 300 } },
  ])('rejects $label without a grant or mutation', async ({ fields }) => {
    await expect(createRecoveryGrant(jwt(fields))).rejects.toBeInstanceOf(RecoveryError);
    expect(puts()).toHaveLength(0); expect(refreshes()).toHaveLength(0);
  });
  it.each([-901, -900])('rejects an expired recovery window (%is)', async offset => {
    await expect(createRecoveryGrant(jwt({ amr: [{ method: 'otp', timestamp: SECOND + offset }] }))).rejects.toMatchObject({ key: 'authRecovery.expiredLink' });
  });
  it('rejects a forged signature despite plausible recovery claims', async () => {
    await expect(createRecoveryGrant(jwt({}, false))).rejects.toMatchObject({ key: 'authRecovery.invalidLink' });
    expect(puts()).toHaveLength(0);
  });
  it.each([true, false])('executes the SDK symmetric-key provider-verification fallback (valid=%s)', async valid => {
    const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const p = token.split('.')[1];
    const signature = createHmac('sha256', 'synthetic-auth-jwt-key').update(`${h}.${p}`).digest('base64url');
    token = `${h}.${p}.${valid ? signature : `${signature[0] === 'a' ? 'b' : 'a'}${signature.slice(1)}`}`;
    responseOverride = call => {
      if (!call.url.pathname.endsWith('/user')) return undefined;
      expect(call.headers.get('authorization')).toBe(`Bearer ${token}`);
      return valid ? Response.json(user()) : Response.json({ code: 'bad_jwt' }, { status: 401 });
    };
    if (valid) expect((await createRecoveryGrant(token)).identity.userId).toBe(A);
    else await expect(createRecoveryGrant(token)).rejects.toMatchObject({ key: 'authRecovery.invalidLink' });
    expect(calls.some(call => call.url.pathname.endsWith('/jwks.json'))).toBe(false);
    expect(calls).toHaveLength(valid ? 2 : 1);
  });
  it('rejects a provider user that differs from the verified subject', async () => {
    userOverride = B;
    await expect(createRecoveryGrant(token)).rejects.toMatchObject({ key: 'authRecovery.sessionChanged' });
  });
  it.each([null, 123, {}, '', 'x'.repeat(321)])('rejects malformed required provider email %j', async email => {
    responseOverride = call => call.url.pathname.endsWith('/user') ? Response.json({ ...user(), email }) : undefined;
    await expect(createRecoveryGrant(token)).rejects.toMatchObject({ key: 'authRecovery.invalidLink' });
  });
  it.each([401, 403, 503])('does not replace a failed current provider lookup (%i) with JWT-only success', async status => {
    responseOverride = call => call.url.pathname.endsWith('/user') ? Response.json({ message: 'private diagnostic' }, { status }) : undefined;
    await expect(createRecoveryGrant(token)).rejects.toBeInstanceOf(RecoveryError);
    expect(calls.filter(call => call.url.pathname.endsWith('/user'))).toHaveLength(1);
  });
  it('does not let SDK transport logging expose thrown provider diagnostics', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    responseOverride = call => { if (call.url.pathname.endsWith('/user')) throw new Error('private credential diagnostic'); return undefined; };
    await expect(createRecoveryGrant(token)).rejects.toMatchObject({ key: 'authRecovery.temporarilyUnavailable' });
    expect(logged).not.toHaveBeenCalled();
  });
  it.each(['access', 'AMR'])('does not mint authority when %s expires during the required user lookup', async kind => {
    token = kind === 'access' ? jwt({ exp: SECOND + 1 }) : jwt({ amr: [{ method: 'otp', timestamp: SECOND - 899 }] });
    responseOverride = call => {
      if (call.url.pathname.endsWith('/user')) vi.spyOn(Date, 'now').mockReturnValue(NOW + 2000);
      return undefined;
    };
    await expect(createRecoveryGrant(token)).rejects.toMatchObject({ key: 'authRecovery.expiredLink' });
  });
  it('retains the original recovery expiry through token refresh and refuses another session', async () => {
    const result = await createRecoveryGrant(token);
    vi.spyOn(Date, 'now').mockReturnValue(NOW + 300_000);
    const rotated = jwt({ iat: SECOND + 300, exp: SECOND + 3900 });
    expect((await verifyRecoveryGrant(result.grant, rotated)).expiresAt).toBe(NOW + 900_000);
    await expect(verifyRecoveryGrant(result.grant, jwt({ session_id: OTHER_SID }))).rejects.toMatchObject({ key: 'authRecovery.sessionChanged' });
    await expect(verifyRecoveryGrant(result.grant, jwt({ sub: B }))).rejects.toMatchObject({ key: 'authRecovery.sessionChanged' });
  });
  it('rejects an expired grant without extending it from a new AMR', async () => {
    const result = await createRecoveryGrant(token);
    vi.spyOn(Date, 'now').mockReturnValue(NOW + 900_000);
    await expect(verifyRecoveryGrant(result.grant, jwt({ iat: SECOND + 900, amr: [{ method: 'recovery', timestamp: SECOND + 900 }] }))).rejects.toMatchObject({ key: 'authRecovery.expiredLink' });
  });
  it('invalidates old grants on service-key rotation and never outputs key material', async () => {
    const result = await createRecoveryGrant(token);
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'rotated-synthetic-service-key');
    await expect(verifyRecoveryGrant(result.grant, token)).rejects.toMatchObject({ key: 'authRecovery.invalidLink' });
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
    await expect(createRecoveryGrant(token)).rejects.toMatchObject({ key: 'authRecovery.setupRequired' });
  });
  it.each(['', 'not-a-token', 'a'.repeat(20000)])('rejects malformed input with safe errors', async value => {
    await expect(createRecoveryGrant(value)).rejects.toMatchObject({ key: 'authRecovery.invalidLink' });
    expect(calls).toHaveLength(0);
  });
  it.each(['jwks.json', '/user'])('bounds a held required SDK %s read without retrying it', async path => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    responseOverride = call => call.url.pathname.endsWith(path) ? new Promise((_resolve, reject) => {
      call.signal?.addEventListener('abort', () => reject(call.signal?.reason), { once: true });
    }) : undefined;
    const observed = createRecoveryGrant(token).catch(error => error);
    await vi.waitFor(() => expect(calls.filter(call => call.url.pathname.endsWith(path))).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(15_001);
    expect(await observed).toMatchObject({ key: 'authRecovery.temporarilyUnavailable' });
    expect(calls.filter(call => call.url.pathname.endsWith(path))).toHaveLength(1);
    expect(puts()).toHaveLength(0);
  });
});

describe('isolated implicit token-pair preparation', () => {
  it('rotates exactly once and returns only a verified matching pair', async () => {
    token = jwt({ amr: [{ method: 'otp', timestamp: SECOND }] });
    refreshed = jwt({ amr: [{ method: 'otp', timestamp: SECOND }], iat: SECOND + 1 });
    const result = await prepareImplicitRecovery(token, 'original-refresh');
    expect(result.session).toEqual({ access_token: refreshed, refresh_token: 'rotated-refresh' });
    expect(result.identity.userId).toBe(A); expect(result.identity.sessionId).toBe(SID);
    expect(refreshes()).toHaveLength(1);
    expect(refreshes()[0].body).toEqual({ refresh_token: 'original-refresh' });
    expect(refreshes()[0].url.search).toBe('?grant_type=refresh_token');
    expect(calls.some(call => call.url.pathname.endsWith('/logout'))).toBe(false);
    expect(puts()).toHaveLength(0);
  });
  it('rejects expired original access before refreshing another identity', async () => {
    refreshed = jwt({ sub: B, session_id: OTHER_SID });
    await expect(prepareImplicitRecovery(jwt({ exp: SECOND - 1 }), 'refresh-B')).rejects.toMatchObject({ key: 'authRecovery.expiredLink' });
    expect(refreshes()).toHaveLength(0);
  });
  it.each([{ sub: B }, { session_id: OTHER_SID }, { amr: [{ method: 'password', timestamp: SECOND }] }])('rejects changed refreshed identity/purpose: %j', async fields => {
    refreshed = jwt(fields);
    await expect(prepareImplicitRecovery(token, 'candidate-refresh')).rejects.toBeInstanceOf(RecoveryError);
    expect(refreshes()).toHaveLength(1); expect(puts()).toHaveLength(0);
  });
  it.each([400, 401, 408, 429, 500, 503])('never retries a rejected or ambiguous refresh (%i)', async status => {
    responseOverride = call => call.url.pathname.endsWith('/token') ? Response.json({ code: 'private-code', message: 'private diagnostic' }, { status }) : undefined;
    await expect(prepareImplicitRecovery(token, 'candidate-refresh')).rejects.toBeInstanceOf(RecoveryError);
    expect(refreshes()).toHaveLength(1);
  });
  it('aborts a held isolated refresh once without session installation or retries', async () => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    responseOverride = call => call.url.pathname.endsWith('/token') ? new Promise((_resolve, reject) => {
      call.signal?.addEventListener('abort', () => reject(call.signal?.reason), { once: true });
    }) : undefined;
    const observed = prepareImplicitRecovery(token, 'candidate-refresh').catch(error => error);
    await vi.waitFor(() => expect(refreshes()).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(15_001);
    expect(await observed).toMatchObject({ key: 'authRecovery.temporarilyUnavailable' });
    expect(refreshes()).toHaveLength(1); expect(puts()).toHaveLength(0);
  });
  it.each([{}, { access_token: 'broken', refresh_token: 'new' }, { access_token: jwt(), refresh_token: '' }, { access_token: jwt(), refresh_token: 'new', user: user(B) }])('refuses malformed refresh success %j', async body => {
    responseOverride = call => call.url.pathname.endsWith('/token') ? Response.json(body) : undefined;
    await expect(prepareImplicitRecovery(token, 'candidate-refresh')).rejects.toBeInstanceOf(RecoveryError);
    expect(refreshes()).toHaveLength(1);
  });
});

describe('exact-token password mutation outcome', () => {
  it('updates only the verified token, with one bounded PUT and no refresh/signout', async () => {
    const { grant } = await createRecoveryGrant(token);
    const result = await updateRecoveryPassword(grant, token, 'New password 123');
    expect(result).toEqual({ outcome: 'updated' });
    expect(puts()).toHaveLength(1);
    expect(puts()[0].headers.get('authorization')).toBe(`Bearer ${token}`);
    expect(puts()[0].body).toEqual({ password: 'New password 123' });
    expect(puts()[0].signal).toBeInstanceOf(AbortSignal);
    expect(refreshes()).toHaveLength(0);
  });
  it.each(['short', 'x'.repeat(73)])('rejects invalid password length before network', async password => {
    const { grant } = await createRecoveryGrant(token); calls = [];
    expect(await updateRecoveryPassword(grant, token, password)).toEqual({ outcome: 'failed', errorKey: 'authRecovery.invalidPassword' });
    expect(calls).toHaveLength(0);
  });
  it.each([8, 72])('accepts the %i character password boundary', async length => {
    const { grant } = await createRecoveryGrant(token);
    expect(await updateRecoveryPassword(grant, token, 'A'.repeat(length))).toEqual({ outcome: 'updated' });
  });
  it.each([
    [422, 'weak_password', 'weakPassword'], [422, 'same_password', 'samePassword'],
    [401, 'insufficient_aal', 'mfaRequired'], [400, 'reauthentication_needed', 'reauthenticationRequired'],
    [400, 'current_password_required', 'currentPasswordRequired'], [429, 'over_request_rate_limit', 'rateLimited'],
    [403, 'user_banned', 'passwordRejected'],
  ])('reports confirmed provider rejection %s/%s honestly', async (status, code, key) => {
    const { grant } = await createRecoveryGrant(token);
    responseOverride = call => call.method === 'PUT' ? Response.json({ code, message: 'private diagnostic' }, { status: Number(status) }) : undefined;
    expect(await updateRecoveryPassword(grant, token, 'New password 123')).toEqual({ outcome: 'failed', errorKey: `authRecovery.${key}` });
    expect(puts()).toHaveLength(1);
  });
  it.each([408, 500, 503])('retains uncertainty after HTTP %i and never repeats PUT', async status => {
    const { grant } = await createRecoveryGrant(token);
    responseOverride = call => call.method === 'PUT' ? Response.json({ message: 'private diagnostic' }, { status }) : undefined;
    expect(await updateRecoveryPassword(grant, token, 'New password 123')).toEqual({ outcome: 'uncertain', errorKey: 'authRecovery.saveUncertain' });
    expect(puts()).toHaveLength(1);
  });
  it.each(['throw', 'wrong-user', 'invalid-json', 'empty', 'oversized'])('treats ambiguous accepted response %s as uncertain', async mode => {
    const { grant } = await createRecoveryGrant(token);
    responseOverride = call => {
      if (call.method !== 'PUT') return;
      if (mode === 'throw') throw new Error('private accepted response lost');
      if (mode === 'wrong-user') return Response.json(user(B));
      if (mode === 'invalid-json') return new Response('not json', { status: 200 });
      if (mode === 'oversized') return Response.json({ id: A, padding: 'x'.repeat(70000) });
      return new Response(null, { status: 204 });
    };
    expect(await updateRecoveryPassword(grant, token, 'New password 123')).toEqual({ outcome: 'uncertain', errorKey: 'authRecovery.saveUncertain' });
    expect(puts()).toHaveLength(1);
  });
  it('refuses a session changed before mutation without sending PUT', async () => {
    const { grant } = await createRecoveryGrant(token);
    expect(await updateRecoveryPassword(grant, jwt({ sub: B, session_id: OTHER_SID }), 'New password 123')).toEqual({ outcome: 'failed', errorKey: 'authRecovery.sessionChanged' });
    expect(puts()).toHaveLength(0);
  });
  it('does not send PUT when the grant expires during current-user verification', async () => {
    const { grant } = await createRecoveryGrant(token);
    vi.spyOn(Date, 'now').mockReturnValue(NOW + 899_000);
    responseOverride = call => {
      if (call.url.pathname.endsWith('/user')) vi.spyOn(Date, 'now').mockReturnValue(NOW + 900_001);
      return undefined;
    };
    expect(await updateRecoveryPassword(grant, token, 'New password 123')).toEqual({ outcome: 'failed', errorKey: 'authRecovery.expiredLink' });
    expect(puts()).toHaveLength(0);
  });
  it('aborts a held PUT at 15 seconds and returns uncertainty', async () => {
    const { grant } = await createRecoveryGrant(token);
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    responseOverride = call => call.method === 'PUT' ? new Promise((_resolve, reject) => {
      call.signal?.addEventListener('abort', () => reject(call.signal?.reason), { once: true });
    }) : undefined;
    const pending = updateRecoveryPassword(grant, token, 'New password 123');
    const observed = pending.then(result => result);
    await vi.waitFor(() => expect(puts()).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(15_001);
    expect(await observed).toEqual({ outcome: 'uncertain', errorKey: 'authRecovery.saveUncertain' });
    expect(puts()).toHaveLength(1); expect(puts()[0].signal?.aborted).toBe(true);
  });
  it('bounds and cancels a held successful response body, retaining uncertainty', async () => {
    const { grant } = await createRecoveryGrant(token);
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    let cancelled = false;
    responseOverride = call => call.method === 'PUT' ? new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 200 }) : undefined;
    const observed = updateRecoveryPassword(grant, token, 'New password 123');
    await vi.waitFor(() => expect(puts()).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(15_001);
    expect(await observed).toEqual({ outcome: 'uncertain', errorKey: 'authRecovery.saveUncertain' });
    expect(cancelled).toBe(true); expect(puts()).toHaveLength(1);
  });
  it('binds grant purpose and expiry under the existing service key', async () => {
    const { grant } = await createRecoveryGrant(token);
    const contents = JSON.parse(Buffer.from(grant.split('.')[0], 'base64url').toString());
    contents.purpose = 'another-operation';
    const payload = Buffer.from(JSON.stringify(contents)).toString('base64url');
    const forged = `${payload}.${createHmac('sha256', SECRET).update('bubaly.auth.recovery.v1\0').update(payload).digest('base64url')}`;
    expect((await updateRecoveryPassword(forged, token, 'New password 123')).outcome).toBe('failed');
    expect(puts()).toHaveLength(0);
  });
});
