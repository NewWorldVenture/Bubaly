import { createHash, randomUUID } from 'node:crypto';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { InMemorySupabase, type Row } from './helpers/in-memory-supabase';

const state = vi.hoisted(() => ({ db: undefined as unknown as InMemorySupabase, userId: '11111111-1111-4111-8111-111111111111', familyId: '22222222-2222-4222-8222-222222222222',
  cookie: '', options: {} as Record<string, unknown>, fault: null as null | { table: string; op: string; occurrence: number; mode: 'error' | 'throw' }, operations: [] as { table: string; op: string }[], responseCap: Infinity, missingCount: '', copy: null as string | null }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => state.db, createServiceClient: () => state.db }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => ({ user: { id: state.userId }, active: {
  familyId: state.familyId, member: { id: '33333333-3333-4333-8333-333333333333', family_id: state.familyId, user_id: state.userId },
} }) }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key === 'socialX.callbackInvalid' && state.copy ? state.copy : key, getLocaleContext: async () => ({ locale: { code: 'en-US' } }) }));
vi.mock('next/headers', () => ({ cookies: async () => ({ set: (_key: string, value: string, options: Record<string, unknown>) => { state.cookie = value; state.options = options; } }) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
import { connectAccountAction, disconnectAccountAction, createPostAction, retryPublishAction } from '@/app/(app)/dashboard/social/actions';
import { GET } from '@/app/api/social/x/callback/route';
import { getConnector, type ConnectorPublishInput } from '@/lib/social/connectors';
import { decryptSecret, encryptSecret } from '@/lib/sync/crypto';
import { X_COOKIE, X_CALLBACK_PATH } from '@/lib/social/x-oauth';

const provider = vi.fn<typeof fetch>();
const originalUser = state.userId;
const originalFamily = state.familyId;
const tokenReply = () => Response.json({ access_token: 'user-access-secret', refresh_token: 'user-refresh-secret', token_type: 'bearer', scope: 'tweet.read tweet.write users.read offline.access', expires_in: 7200 });
const identityReply = () => Response.json({ data: { id: '123456789', username: 'example', name: 'Example' } });
function installFaults(db: InMemorySupabase) {
  const from = db.from.bind(db);
  db.from = ((table: string) => {
    const query = from(table);
    let op = 'select';
    const execute = (run: () => PromiseLike<unknown>) => {
      state.operations.push({ table, op });
      const fault = state.fault;
      if (fault?.table === table && fault.op === op && --fault.occurrence === 0) {
        state.fault = null;
        return fault.mode === 'throw' ? Promise.reject(new Error('private-provider-secret')) : Promise.resolve({ data: null, error: { message: 'private-provider-secret' } });
      }
      return Promise.resolve(run()).then((result) => {
        const response = result as { data: unknown; count: number | null };
        if (op === 'select' && Array.isArray(response.data)) response.data = response.data.slice(0, state.responseCap);
        if (table === state.missingCount) response.count = null;
        return response;
      });
    };
    const proxy = new Proxy(query, { get(target, key) {
      if (key === 'then') return (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => {
        return execute(() => target).then(resolve, reject);
      };
      if (key === 'single' || key === 'maybeSingle') return () => execute(() => target[key]());
      const method = Reflect.get(target, key);
      if (typeof method !== 'function') return method;
      return (...args: unknown[]) => { if (['insert', 'update', 'upsert', 'delete'].includes(String(key))) op = String(key); method.apply(target, args); return proxy; };
    } });
    return proxy;
  }) as typeof db.from;
}
beforeEach(() => {
  vi.stubEnv('X_CLIENT_ID', 'app-client'); vi.stubEnv('X_CLIENT_SECRET', 'app-secret'); vi.stubEnv('SYNC_TOKEN_KEY', '11'.repeat(32)); vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example');
  state.userId = originalUser; state.familyId = originalFamily; state.cookie = ''; state.fault = null; state.operations = []; state.responseCap = Infinity; state.missingCount = ''; state.copy = null;
  state.db = new InMemorySupabase({ userId: originalUser, uniques: { social_accounts: [['id'], ['family_id', 'platform', 'provider_account_id']], social_account_tokens: [['id']] }, defaults: { social_posts: { approval_status: 'not_required' }, social_accounts: { deleted_at: null, provider_account_id: null }, social_account_tokens: { provider_account_id: null } } });
  state.db.seed('family_members', [{ id: '33333333-3333-4333-8333-333333333333', family_id: originalFamily, user_id: originalUser, role: 'parent', is_active: true }]);
  installFaults(state.db);
  provider.mockReset(); vi.stubGlobal('fetch', provider);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

async function begin() {
  const fd = new FormData(); fd.set('platform', 'x');
  const result = await connectAccountAction(fd);
  expect(result, 'X connect action result').toMatchObject({ ok: true });
  if (!('authorizationUrl' in result) || !result.authorizationUrl) throw new Error('missing authorization URL');
  return { url: new URL(result.authorizationUrl), cookie: state.cookie, accountId: String(state.db.table('social_accounts').at(-1)!.id) };
}
function callback(flow: Awaited<ReturnType<typeof begin>>, query = '') {
  return new NextRequest(`https://app.example${X_CALLBACK_PATH}?code=authorization-code&state=${flow.url.searchParams.get('state')}${query}`, { headers: { cookie: `${X_COOKIE}=${encodeURIComponent(flow.cookie)}` } });
}
async function connected() {
  const flow = await begin(); provider.mockResolvedValueOnce(tokenReply()).mockResolvedValueOnce(identityReply());
  expect((await GET(callback(flow))).status).toBe(307);
  return flow;
}
function input(accountId: string): ConnectorPublishInput { return { platform: 'x', providerAccountId: '123456789', accountId, familyId: originalFamily, userId: originalUser, kind: 'text', body: 'Hello', mediaUrls: [] }; }

describe('X action → OAuth callback → encrypted credentials → live registry', () => {
  it.each(['confirmed', 'unknown'])('runs the actual create-post action and publish pipeline after OAuth: %s', async (outcome) => {
    const flow = await connected(); provider.mockClear();
    if (outcome === 'confirmed') provider.mockResolvedValueOnce(Response.json({ data: { id: '987654321' } }, { status: 201 }));
    else provider.mockRejectedValueOnce(new DOMException('deadline', 'TimeoutError'));
    const fd = new FormData(); fd.set('body', 'Created through the action'); fd.set('kind', 'text'); fd.set('intent', 'publish'); fd.append('platforms', 'x'); fd.append('account_ids', flow.accountId);
    const result = await createPostAction(fd);
    const expected = outcome === 'confirmed' ? 'published' : 'publishing';
    expect(result).toMatchObject({ ok: true, action: 'publish', outcome: { status: expected } });
    expect(result.postId).toBeTruthy(); expect(provider).toHaveBeenCalledOnce();
    expect(state.db.table('social_posts')[0].status).toBe(expected);
    expect(state.db.table('social_post_targets')[0]).toMatchObject({ status: expected, account_id: flow.accountId });
    expect(state.db.table('social_publish_results')[0]).toMatchObject({ status: expected, provider_object_id: outcome === 'confirmed' ? '987654321' : null });
    const retry = await retryPublishAction(result.postId!);
    expect(retry).toMatchObject({ ok: true, postId: result.postId, outcome: { status: expected } });
    expect(provider).toHaveBeenCalledOnce(); expect(state.db.table('social_posts')).toHaveLength(1);
  });
  it('renders an escaped translated recovery page with a fixed clickable accounts link and no reflected OAuth values', async () => {
    state.copy = 'Start again <safely> & "privately"';
    const response = await GET(new NextRequest(`https://app.example${X_CALLBACK_PATH}?state=raw-secret-state&code=raw-secret-code&error_description=%3Cscript%3Ebad%3C%2Fscript%3E`));
    expect(response.status).toBe(400); expect(response.headers.get('content-type')).toContain('text/html');
    expect(response.headers.get('cache-control')).toBe('no-store'); expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    const body = await response.text();
    expect(body).toContain('Start again &lt;safely&gt; &amp; &quot;privately&quot;');
    expect(body).toContain('<a href="/dashboard/social/accounts">dashboardSocialAccountsConnect.backToAccounts</a>');
    expect(body).not.toContain('raw-secret'); expect(body).not.toContain('<script>'); expect(provider).not.toHaveBeenCalled();
  });
  it.each(['missing-secret', 'weak-key', 'whitespace-key', 'http-origin', 'credentials-origin', 'path-origin'])('fails closed for %s setup without storing a flow', async (reason) => {
    if (reason === 'missing-secret') vi.stubEnv('X_CLIENT_SECRET', '');
    if (reason === 'weak-key') vi.stubEnv('SYNC_TOKEN_KEY', 'passphrase');
    if (reason === 'whitespace-key') vi.stubEnv('SYNC_TOKEN_KEY', ' ');
    if (reason === 'http-origin') vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://public.example');
    if (reason === 'credentials-origin') vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://user:pass@app.example');
    if (reason === 'path-origin') vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example/other');
    const fd = new FormData(); fd.set('platform', 'x');
    expect(await connectAccountAction(fd)).toMatchObject({ ok: false, error: 'socialX.setupRequired' });
    expect(state.db.table('social_accounts')).toHaveLength(0); expect(provider).not.toHaveBeenCalled();
  });
  it.each(['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000'])('permits an explicit loopback development origin: %s', async (origin) => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', origin);
    const flow = await begin();
    expect(flow.url.searchParams.get('redirect_uri')).toBe(`${origin}${X_CALLBACK_PATH}`);
    expect(state.options.secure).toBe(false);
  });
  it.each(['social_accounts', 'social_account_tokens'])('checks the initial %s receipt write before returning an authorization URL', async (table) => {
    state.fault = { table, op: 'insert', occurrence: 1, mode: 'error' };
    const fd = new FormData(); fd.set('platform', 'x');
    expect(await connectAccountAction(fd)).toMatchObject({ ok: false, error: 'socialX.storageUnavailable' });
    expect(state.cookie).toBe(''); expect(provider).not.toHaveBeenCalled();
  });
  it('uses PKCE, a private one-use receipt, and only the bound user token for a confirmed text/link post', async () => {
    const flow = await begin();
    const plaintext = JSON.parse(decryptSecret(flow.cookie));
    expect(flow.url.origin + flow.url.pathname).toBe('https://x.com/i/oauth2/authorize');
    expect(flow.url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(flow.url.searchParams.get('code_challenge')).toBe(createHash('sha256').update(plaintext.verifier).digest('base64url'));
    expect(flow.url.toString()).not.toContain(plaintext.verifier);
    expect(state.options).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax', path: X_CALLBACK_PATH, maxAge: 600 });
    expect(state.db.table('social_accounts')[0].status).toBe('pending');
    provider.mockResolvedValueOnce(tokenReply()).mockResolvedValueOnce(identityReply());
    const response = await GET(callback(flow));
    expect(response.status).toBe(307); expect(response.headers.get('location')).toBe('https://app.example/dashboard/social/accounts');
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    const row = state.db.table('social_account_tokens')[0];
    expect(row.id).toBe(flow.accountId); expect(row.account_id).toBe(flow.accountId);
    expect(JSON.stringify(state.db.table('social_account_tokens'))).not.toContain('user-access-secret');
    expect(JSON.stringify(state.db.table('social_accounts'))).not.toContain('user-refresh-secret');
    expect(JSON.parse(decryptSecret(String(row.access_token_enc)))).toMatchObject({ accountId: flow.accountId, familyId: originalFamily, providerAccountId: '123456789', accessToken: 'user-access-secret', refreshToken: '' });
    expect(JSON.parse(decryptSecret(String(row.refresh_token_enc)))).toMatchObject({ accessToken: '', refreshToken: 'user-refresh-secret' });
    provider.mockResolvedValueOnce(Response.json({ data: { id: '987654321', text: 'ignored' }, secrets: 'never saved' }, { status: 201 }));
    const result = await getConnector('x').publish({ ...input(flow.accountId), kind: 'link', link: 'https://example.org/story' });
    expect(result).toEqual({ ok: true, status: 'published', providerObjectId: '987654321', permalinkUrl: 'https://x.com/i/status/987654321', raw: { id: '987654321' } });
    expect(provider.mock.calls.map(([url]) => url)).toEqual(['https://api.x.com/2/oauth2/token', 'https://api.x.com/2/users/me', 'https://api.x.com/2/tweets']);
    const exchange = provider.mock.calls[0][1]!;
    expect(exchange.redirect).toBe('manual'); expect(exchange.signal).toBeInstanceOf(AbortSignal);
    expect(new URLSearchParams(String(exchange.body)).get('code_verifier')).toBe(plaintext.verifier);
    expect(exchange.headers).toMatchObject({ Authorization: `Basic ${Buffer.from('app-client:app-secret').toString('base64')}` });
    const post = provider.mock.calls[2][1]!;
    expect(post.headers).toMatchObject({ Authorization: 'Bearer user-access-secret' });
    expect(JSON.parse(String(post.body))).toEqual({ text: 'Hello\nhttps://example.org/story' });
    expect((await GET(callback(flow))).status).toBe(400); expect(provider).toHaveBeenCalledTimes(3);
  });

  it.each(['state', 'tampered', 'expired', 'origin', 'duplicate', 'user', 'family', 'permission', 'member'])('rejects %s mismatch before any provider request', async (reason) => {
    const flow = await begin();
    let request = callback(flow);
    if (reason === 'state') request = new NextRequest(request.url.replace(/state=[^&]+/, `state=${'x'.repeat(43)}`), { headers: request.headers });
    if (reason === 'tampered') flow.cookie = `bad${flow.cookie}`;
    if (reason === 'expired') { const payload = JSON.parse(decryptSecret(flow.cookie)); payload.issuedAt -= 700000; payload.expiresAt -= 700000; flow.cookie = encryptSecret(JSON.stringify(payload)); }
    if (reason === 'origin') request = new NextRequest(request.url.replace('app.example', 'evil.example'), { headers: request.headers });
    if (reason === 'duplicate') request = callback(flow, '&code=second-code');
    if (reason === 'user') state.userId = randomUUID();
    if (reason === 'family') state.familyId = randomUUID();
    if (reason === 'permission') state.db.seed('social_access_permissions', [{ family_id: originalFamily, user_id: originalUser, social_role: 'read_only', status: 'active' }]);
    if (reason === 'member') state.db.table('family_members')[0].is_active = false;
    if (['tampered', 'expired'].includes(reason)) request = callback(flow);
    expect((await GET(request)).status).toBe(400); expect(provider).not.toHaveBeenCalled();
  });

  it('claims before exchange so two concurrent callbacks only exchange once', async () => {
    const flow = await begin(); provider.mockResolvedValueOnce(tokenReply()).mockResolvedValueOnce(identityReply());
    const responses = await Promise.all([GET(callback(flow)), GET(callback(flow))]);
    expect(responses.map((r) => r.status).sort()).toEqual([307, 400]); expect(provider).toHaveBeenCalledTimes(2);
  });

  it.each(['scope', 'identity', 'redirect', 'token-http', 'network', 'large'])('rejects invalid %s provider response without connecting or exposing secrets', async (reason) => {
    const flow = await begin();
    if (reason === 'scope') provider.mockResolvedValueOnce(Response.json({ access_token: 'private-provider-secret', refresh_token: 'refresh', token_type: 'bearer', expires_in: 7200, scope: 'users.read' }));
    else if (reason === 'redirect') provider.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://evil.example' } }));
    else if (reason === 'token-http') provider.mockResolvedValueOnce(new Response('private-provider-secret', { status: 401 }));
    else if (reason === 'network') provider.mockRejectedValueOnce(new Error('private-provider-secret'));
    else if (reason === 'large') provider.mockResolvedValueOnce(new Response('x'.repeat(70000)));
    else provider.mockResolvedValueOnce(tokenReply()).mockResolvedValueOnce(Response.json({ data: { id: 'not-an-id', username: 'example', name: 'Example' } }));
    const response = await GET(callback(flow));
    expect(response.status).toBe(400); expect(await response.text()).not.toContain('private-provider-secret');
    expect(state.db.table('social_accounts')[0].status).toBe('pending');
    expect(state.db.table('social_account_tokens')[0].access_token_enc).toBeUndefined();
  });

  it.each(['disconnect', 'permission', 'member'])('fences %s during provider exchange before connection finalization', async (reason) => {
    const flow = await begin();
    provider.mockImplementationOnce(async () => {
      if (reason === 'disconnect') await disconnectAccountAction(flow.accountId);
      if (reason === 'permission') state.db.seed('social_access_permissions', [{ family_id: originalFamily, user_id: originalUser, social_role: 'read_only', status: 'active' }]);
      if (reason === 'member') state.db.table('family_members')[0].is_active = false;
      return tokenReply();
    }).mockResolvedValueOnce(identityReply());
    expect((await GET(callback(flow))).status).toBe(400);
    expect(state.db.table('social_accounts')[0].status).not.toBe('connected');
  });

  it.each(['error', 'throw'] as const)('checks failed token persistence (%s) before reporting connected', async (mode) => {
    const flow = await begin();
    state.fault = { table: 'social_account_tokens', op: 'update', occurrence: 2, mode };
    provider.mockResolvedValueOnce(tokenReply()).mockResolvedValueOnce(identityReply());
    const response = await GET(callback(flow)); expect(response.status).toBe(400); expect(await response.text()).not.toContain('private-provider-secret');
    expect(state.db.table('social_accounts')[0].status).toBe('pending');
  });
  it.each(['claim', 'final-account', 'callback-permission-read'])('fences %s persistence/read failure', async (stage) => {
    const flow = await begin();
    state.fault = stage === 'claim' ? { table: 'social_account_tokens', op: 'update', occurrence: 1, mode: 'error' } : stage === 'final-account'
      ? { table: 'social_accounts', op: 'update', occurrence: 2, mode: 'throw' } : { table: 'social_access_permissions', op: 'select', occurrence: 1, mode: 'error' };
    provider.mockResolvedValueOnce(tokenReply()).mockResolvedValueOnce(identityReply());
    expect((await GET(callback(flow))).status).toBe(400);
    expect(state.db.table('social_accounts')[0].status).toBe('pending');
    expect(provider).toHaveBeenCalledTimes(stage === 'final-account' ? 2 : 0);
  });

  it('reconnects a verified existing identity through its same canonical row', async () => {
    const first = await connected();
    const again = await begin(); provider.mockResolvedValueOnce(tokenReply()).mockResolvedValueOnce(identityReply());
    expect((await GET(callback(again))).status).toBe(307);
    const connectedRows = state.db.table('social_accounts').filter((r) => r.status === 'connected');
    expect(connectedRows.map((r) => r.id)).toEqual([first.accountId]);
    expect(state.db.table('social_account_tokens').filter((r) => r.account_id === first.accountId)).toHaveLength(1);
    expect(state.db.table('social_accounts').find((r) => r.id === again.accountId)?.deleted_at).toBeTruthy();
  });
  it('does not let older authorization undo private revocation when the public disconnect write failed', async () => {
    const first = await connected();
    const again = await begin();
    state.fault = { table: 'social_accounts', op: 'update', occurrence: 1, mode: 'error' };
    expect((await disconnectAccountAction(first.accountId)).ok).toBe(false);
    expect(state.db.table('social_accounts')[0].status).toBe('connected');
    provider.mockResolvedValueOnce(tokenReply()).mockResolvedValueOnce(identityReply());
    expect((await GET(callback(again))).status).toBe(400);
    expect((state.db.table('social_account_tokens')[0].metadata as Row).x_state).toBe('blocked');
    provider.mockClear();
    expect((await getConnector('x').publish(input(first.accountId))).status).toBe('failed');
    expect(provider).not.toHaveBeenCalled();
  });
  it('allows a new explicit authorization after a completed disconnect', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-12T15:00:00Z'));
    const first = await connected(); expect((await disconnectAccountAction(first.accountId)).ok).toBe(true);
    vi.setSystemTime(new Date('2026-09-12T15:00:01Z'));
    const again = await begin(); provider.mockResolvedValueOnce(tokenReply()).mockResolvedValueOnce(identityReply());
    expect((await GET(callback(again))).status).toBe(307);
    expect(state.db.table('social_accounts')[0]).toMatchObject({ id: first.accountId, status: 'connected', deleted_at: null });
  });
  it('rejects an authorization which expires during exchange, before finalization', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-12T15:00:00Z'));
    const flow = await begin();
    provider.mockImplementationOnce(async () => { vi.setSystemTime(new Date('2026-09-12T15:10:01Z')); return tokenReply(); }).mockResolvedValueOnce(identityReply());
    expect((await GET(callback(flow))).status).toBe(400);
    expect(state.db.table('social_accounts')[0].status).toBe('pending');
    expect(state.db.table('social_account_tokens')[0].access_token_enc).toBeUndefined();
  });
  it('rejects duplicate provider identity rows even when API cap hides the second row', async () => {
    const first = await connected(); const again = await begin();
    state.db.seed('social_accounts', [{ ...state.db.table('social_accounts')[0], id: randomUUID() }]);
    state.responseCap = 1;
    provider.mockResolvedValueOnce(tokenReply()).mockResolvedValueOnce(identityReply());
    expect((await GET(callback(again))).status).toBe(400);
    expect(state.db.table('social_accounts').find((row) => row.id === first.accountId)?.status).toBe('connected');
  });
});

describe('X publish failure and authority boundaries', () => {
  it.each([400, 401, 403, 429])('treats confirmed HTTP %i as rejection without retrying', async (status) => {
    const flow = await connected(); provider.mockClear(); provider.mockResolvedValueOnce(new Response('provider-secret', { status }));
    const result = await getConnector('x').publish(input(flow.accountId));
    expect(result.status).toBe('failed'); expect(result.ok).toBe(false); expect(JSON.stringify(result)).not.toContain('provider-secret'); expect(provider).toHaveBeenCalledTimes(1);
  });
  it.each(['timeout', '500', 'redirect', '200', 'invalid-id', 'malformed', 'oversized'])('retains uncertainty for %s after dispatch', async (reason) => {
    const flow = await connected(); provider.mockClear();
    if (reason === 'timeout') provider.mockRejectedValueOnce(new DOMException('private-provider-secret', 'TimeoutError'));
    else if (reason === '500') provider.mockResolvedValueOnce(new Response('error', { status: 500 }));
    else if (reason === 'redirect') provider.mockResolvedValueOnce(new Response(null, { status: 307, headers: { location: 'https://evil.example' } }));
    else if (reason === '200') provider.mockResolvedValueOnce(Response.json({ data: { id: '123456789' } }));
    else if (reason === 'invalid-id') provider.mockResolvedValueOnce(Response.json({ data: { id: 123456789 } }, { status: 201 }));
    else if (reason === 'malformed') provider.mockResolvedValueOnce(new Response('not-json', { status: 201 }));
    else provider.mockResolvedValueOnce(new Response('x'.repeat(70000), { status: 201 }));
    expect(await getConnector('x').publish(input(flow.accountId))).toEqual({ ok: false, status: 'publishing', errorCode: 'confirmation_unknown', errorMessage: 'socialX.publishUnknown' });
    expect(provider).toHaveBeenCalledTimes(1);
  });
  it.each(['missing-context', 'wrong-family', 'wrong-user', 'wrong-provider', 'duplicate', 'duplicate-capped', 'missing-count', 'transplant', 'expired', 'refreshing', 'disconnected', 'permission', 'read-error', 'token-read-error'])('does not dispatch for %s', async (reason) => {
    const flow = await connected(); provider.mockClear(); const request = input(flow.accountId);
    const token = state.db.table('social_account_tokens')[0];
    if (reason === 'missing-context') delete request.userId;
    if (reason === 'wrong-family') request.familyId = randomUUID();
    if (reason === 'wrong-user') request.userId = randomUUID();
    if (reason === 'wrong-provider') request.providerAccountId = '999999999';
    if (reason === 'duplicate' || reason === 'duplicate-capped') state.db.seed('social_account_tokens', [{ ...token, id: randomUUID() }]);
    if (reason === 'duplicate-capped') state.responseCap = 1;
    if (reason === 'missing-count') state.missingCount = 'social_account_tokens';
    if (reason === 'transplant') { const envelope = JSON.parse(decryptSecret(String(token.access_token_enc))); envelope.accountId = randomUUID(); token.access_token_enc = encryptSecret(JSON.stringify(envelope)); }
    if (reason === 'expired') { const envelope = JSON.parse(decryptSecret(String(token.access_token_enc))); envelope.expiresAt = Date.now() - 1000; token.expires_at = new Date(envelope.expiresAt).toISOString(); token.access_token_enc = encryptSecret(JSON.stringify(envelope)); }
    if (reason === 'refreshing') token.metadata = { ...(token.metadata as Row), x_state: 'refreshing' };
    if (reason === 'disconnected') { expect((await disconnectAccountAction(flow.accountId)).ok).toBe(true); state.db.table('social_accounts')[0].status = 'connected'; state.db.table('social_accounts')[0].deleted_at = null; }
    if (reason === 'permission') state.db.seed('social_access_permissions', [{ family_id: originalFamily, user_id: originalUser, social_role: 'read_only', status: 'active' }]);
    if (reason === 'read-error') state.fault = { table: 'social_access_permissions', op: 'select', occurrence: 1, mode: 'error' };
    if (reason === 'token-read-error') state.fault = { table: 'social_account_tokens', op: 'select', occurrence: 1, mode: 'throw' };
    expect((await getConnector('x').publish(request)).status).toBe('failed');
    // None of these may reach the post endpoint. 'expired' is the one that
    // legitimately touches the network at all — it spends a refresh first, and
    // fails here because no reply to that refresh is mocked.
    expect(provider.mock.calls.map(([url]) => url)).toEqual(reason === 'expired' ? ['https://api.x.com/2/oauth2/token'] : []);
  });
  it.each([{ kind: 'image' }, { mediaUrls: ['https://example.org/image.jpg'] }, { kind: 'link', link: 'file:///x' }, { kind: 'link' }, { body: 'x'.repeat(281) }, { body: ' ' }])('rejects unsupported/invalid content before sending: %j', async (patch) => {
    const flow = await connected(); provider.mockClear();
    expect((await getConnector('x').publish({ ...input(flow.accountId), ...patch })).status).toBe('failed'); expect(provider).not.toHaveBeenCalled();
  });
  it('keeps unsupported provider implementations honestly unavailable', async () => {
    vi.stubEnv('REDDIT_CLIENT_ID', 'configured'); vi.stubEnv('REDDIT_CLIENT_SECRET', 'configured');
    const result = await getConnector('reddit').publish({ platform: 'reddit', providerAccountId: 'example', body: 'test', mediaUrls: [] });
    expect(result.ok).toBe(false); expect(result.status).not.toBe('published'); expect(provider).not.toHaveBeenCalled();
  });
  it('uses the deadline signal through response-body consumption and leaves an aborted post uncertain', async () => {
    const flow = await connected(); provider.mockClear();
    const controller = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    provider.mockImplementationOnce(async (_url, init) => new Response(new ReadableStream({ start(stream) {
      init!.signal!.addEventListener('abort', () => stream.error(new DOMException('deadline', 'AbortError')), { once: true });
      queueMicrotask(() => controller.abort());
    } }), { status: 201 }));
    expect(await getConnector('x').publish(input(flow.accountId))).toMatchObject({ status: 'publishing', errorCode: 'confirmation_unknown' });
    expect(AbortSignal.timeout).toHaveBeenCalledWith(15_000); expect(provider).toHaveBeenCalledTimes(1);
  });
  it.each(['redirect', 'advertised-large', 'stream-large'])('cancels unused or excessive %s provider response bodies', async (reason) => {
    const flow = await connected(); provider.mockClear(); const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(stream) { stream.enqueue(new Uint8Array(reason === 'stream-large' ? 70000 : 8)); }, cancel });
    provider.mockResolvedValueOnce(new Response(body, { status: reason === 'redirect' ? 307 : 201, headers: reason === 'advertised-large' ? { 'content-length': '70000' } : {} }));
    expect((await getConnector('x').publish(input(flow.accountId))).status).toBe('publishing');
    expect(cancel).toHaveBeenCalledOnce(); expect(provider).toHaveBeenCalledTimes(1);
  });
});

// An X access token lasts about two hours. `offline.access` is requested so a
// post scheduled for tomorrow morning can still go out — but nothing ever spent
// the refresh token, so every publish past that two-hour window failed as
// "reconnect required" and a recurring schedule quietly stopped recurring.
describe('X credentials outlive the two-hour access token', () => {
  const rotatedReply = () => Response.json({ access_token: 'rotated-access-secret', refresh_token: 'rotated-refresh-secret',
    token_type: 'bearer', scope: 'tweet.read tweet.write users.read offline.access', expires_in: 7200 });
  const tokenRow = (accountId: string) => state.db.table('social_account_tokens').find((row) => row.id === accountId)!;
  const storedRefreshToken = (accountId: string) => JSON.parse(decryptSecret(String(tokenRow(accountId).refresh_token_enc))).refreshToken;
  const tokenState = (accountId: string) => (tokenRow(accountId).metadata as Record<string, unknown>).x_state;
  const basic = `Basic ${Buffer.from('app-client:app-secret').toString('base64')}`;

  /** A connection made yesterday afternoon, read the next morning. */
  async function expiredConnection() {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-12T15:00:00Z'));
    const flow = await connected();
    vi.setSystemTime(new Date('2026-09-13T09:00:00Z'));
    provider.mockClear();
    return flow;
  }

  it('spends the refresh token and publishes with the rotated credential', async () => {
    const flow = await expiredConnection();
    expect(storedRefreshToken(flow.accountId)).toBe('user-refresh-secret');
    provider.mockResolvedValueOnce(rotatedReply()).mockResolvedValueOnce(Response.json({ data: { id: '987654321' } }, { status: 201 }));

    const result = await getConnector('x').publish(input(flow.accountId));
    expect(result).toMatchObject({ ok: true, status: 'published', providerObjectId: '987654321' });
    expect(provider.mock.calls.map(([url]) => url)).toEqual(['https://api.x.com/2/oauth2/token', 'https://api.x.com/2/tweets']);

    const refresh = provider.mock.calls[0][1]!;
    const body = new URLSearchParams(String(refresh.body));
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('user-refresh-secret');
    expect(refresh.headers).toMatchObject({ Authorization: basic });
    expect(refresh.redirect).toBe('manual');
    // X invalidates the refresh token the moment it is spent, so storing the
    // rotated one is what keeps the connection alive past this single publish.
    expect(storedRefreshToken(flow.accountId)).toBe('rotated-refresh-secret');
    expect(tokenRow(flow.accountId).expires_at).toBe('2026-09-13T11:00:00.000Z');
    expect(provider.mock.calls[1][1]!.headers).toMatchObject({ Authorization: 'Bearer rotated-access-secret' });
  });

  it('spends only one refresh for a second publish inside the new window', async () => {
    const flow = await expiredConnection();
    provider.mockResolvedValueOnce(rotatedReply()).mockResolvedValueOnce(Response.json({ data: { id: '1' } }, { status: 201 }));
    expect((await getConnector('x').publish(input(flow.accountId))).status).toBe('published');
    provider.mockClear().mockResolvedValueOnce(Response.json({ data: { id: '2' } }, { status: 201 }));
    expect((await getConnector('x').publish(input(flow.accountId))).status).toBe('published');
    expect(provider.mock.calls.map(([url]) => url)).toEqual(['https://api.x.com/2/tweets']);
  });

  it('blocks the credential and never attempts the post when X rejects the refresh token', async () => {
    const flow = await expiredConnection();
    provider.mockResolvedValueOnce(new Response('{"error":"invalid_grant"}', { status: 400 }));
    const result = await getConnector('x').publish(input(flow.accountId));
    expect(result).toMatchObject({ ok: false, status: 'failed', errorMessage: 'socialX.reconnectRequired' });
    // Spent or revoked: retrying it on every later publish would burn a round
    // trip to reach the same answer, and the member must reconnect either way.
    expect(tokenState(flow.accountId)).toBe('blocked');
    expect(tokenRow(flow.accountId).refresh_token_enc).toBeNull();
    expect(tokenRow(flow.accountId).access_token_enc).toBeNull();
    expect(state.db.table('social_accounts').find((row) => row.id === flow.accountId)!.last_error).toBe('socialX.reconnectRequired');
    expect(provider).toHaveBeenCalledOnce();
  });

  it('keeps the credential when X is briefly unreachable, and the next attempt still works', async () => {
    const flow = await expiredConnection();
    provider.mockResolvedValueOnce(new Response('', { status: 503 }));
    expect((await getConnector('x').publish(input(flow.accountId))).status).toBe('failed');
    expect(tokenState(flow.accountId)).toBe('ready');
    expect(storedRefreshToken(flow.accountId)).toBe('user-refresh-secret');

    provider.mockClear().mockResolvedValueOnce(rotatedReply()).mockResolvedValueOnce(Response.json({ data: { id: '987654321' } }, { status: 201 }));
    expect((await getConnector('x').publish(input(flow.accountId))).status).toBe('published');
    expect(storedRefreshToken(flow.accountId)).toBe('rotated-refresh-secret');
  });

  it('lets the member reconnect over a rotation that died mid-flight', async () => {
    const flow = await expiredConnection();
    // The process is killed between claiming the row and storing the new grant.
    // Without a way back out of 'refreshing', that account is bricked: it cannot
    // publish, and the one remedy a member has would be refused too.
    tokenRow(flow.accountId).metadata = { x_state: 'refreshing', x_revision: 'abandoned-rotation' };

    const again = await begin();
    provider.mockResolvedValueOnce(tokenReply()).mockResolvedValueOnce(identityReply());
    expect((await GET(callback(again))).status).toBe(307);
    const reconnected = state.db.table('social_account_tokens').find((row) => row.provider_account_id === '123456789')!;
    expect((reconnected.metadata as Record<string, unknown>).x_state).toBe('ready');
    expect(JSON.parse(decryptSecret(String(reconnected.refresh_token_enc))).refreshToken).toBe('user-refresh-secret');
  });

  it('refuses a refreshed grant that came back without the publish scopes', async () => {
    const flow = await expiredConnection();
    provider.mockResolvedValueOnce(Response.json({ access_token: 'narrow', refresh_token: 'narrow-refresh',
      token_type: 'bearer', scope: 'tweet.read users.read', expires_in: 7200 }));
    expect((await getConnector('x').publish(input(flow.accountId))).status).toBe('failed');
    expect(tokenState(flow.accountId)).toBe('blocked');
    expect(provider).toHaveBeenCalledOnce();
  });
});
