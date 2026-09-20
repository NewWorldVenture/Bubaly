import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveChildPassword } from '@/lib/onboarding/child-password';

const state = vi.hoisted(() => ({
  cookieFactory: vi.fn(), cookieWrite: vi.fn(), serverFactory: vi.fn(), rateLimit: vi.fn(), request: vi.fn(),
  lookupError: null as null | { message: string }, throttleError: null as null | { message: string },
  writeError: null as null | { message: string }, unknown: false,
  throttle: null as null | { fails: number; window_start: string; locked_until: string | null },
  upserts: [] as Array<Record<string, unknown>>, tables: [] as string[],
  options: [] as Array<Record<string, unknown>>, disposals: [] as Array<ReturnType<typeof vi.fn>>,
}));
vi.mock('next/headers', () => ({ cookies: state.cookieFactory, headers: async () => new Headers({ 'x-forwarded-for': '192.0.2.1' }) }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/auth', () => ({ getUserContext: vi.fn(), isSuperAdmin: vi.fn() }));
vi.mock('@/lib/marketing/identity', () => ({ stitchVisitorIdentity: vi.fn() }));
vi.mock('@/lib/server/request-rate-limit', () => ({ enforceRequestRateLimit: state.rateLimit }));
vi.mock('@/lib/supabase/server', () => ({
  createServer: state.serverFactory,
  createServiceClient: () => ({ from: (table: string) => {
    state.tables.push(table);
    const chain = {
      select: () => chain, eq: () => chain, ilike: () => chain,
      maybeSingle: async () => ({ data: state.throttle, error: state.throttleError }),
      limit: async () => ({ data: state.unknown ? [] : [{ username: 'emma', user_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }], error: state.lookupError }),
      upsert: async (value: Record<string, unknown>) => { state.upserts.push(value); return { error: state.writeError }; },
    };
    return chain;
  } }),
}));
vi.mock('@supabase/supabase-js', async importOriginal => {
  const actual = await importOriginal<typeof import('@supabase/supabase-js')>();
  return { ...actual, createClient: (url: string, key: string, options: Parameters<typeof actual.createClient>[2]) => {
    state.options.push(options as Record<string, unknown>);
    const client = actual.createClient(url, key, { ...options, global: { ...options?.global, fetch: state.request } });
    state.disposals.push(vi.spyOn(client.auth, 'dispose'));
    return client;
  } };
});
import { childSignInAction } from '@/app/(auth)/actions';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function receipt() {
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const token = [Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({ sub: id, session_id: '11111111-1111-4111-8111-111111111111', exp: expires })).toString('base64url'), 'synthetic-signature'].join('.');
  return { access_token: token, refresh_token: 'synthetic-authorized-child-refresh', token_type: 'bearer', expires_in: 3600,
    user: { id, email: 'child.emma@kids.bubaly.app', aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-09-12T00:00:00Z' } };
}
function respond(body: unknown, status = 200) { state.request.mockImplementation(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })); }
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('CHILD_LOGIN_SECRET', 'synthetic-child-derivation-fixture');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://child-action-fixture.invalid');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'synthetic-public-anon');
  state.lookupError = state.throttleError = state.writeError = null;
  state.unknown = false; state.throttle = null;
  state.upserts = []; state.tables = []; state.options = []; state.disposals = [];
  state.rateLimit.mockResolvedValue({ ok: true });
  state.cookieFactory.mockResolvedValue({ set: state.cookieWrite });
  state.serverFactory.mockImplementation(() => { throw new Error('Cookie-bound auth must not run'); });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  respond(receipt());
});
afterEach(() => {
  expect(state.cookieFactory).not.toHaveBeenCalled();
  expect(state.cookieWrite).not.toHaveBeenCalled();
  expect(state.serverFactory).not.toHaveBeenCalled();
  for (const dispose of state.disposals) expect(dispose).toHaveBeenCalledTimes(1);
  vi.unstubAllEnvs(); vi.restoreAllMocks();
});

describe('child password action returns a candidate without adopting browser storage', () => {
  it('runs the real SDK against the synthetic provider and returns only the authorized token pair', async () => {
    const expected = receipt(); respond(expected);
    const result = await childSignInAction({ username: ' EmMa ', pin: '1234' });
    expect(result).toEqual({ ok: true, tokens: { access_token: expected.access_token, refresh_token: expected.refresh_token } });
    expect(state.request).toHaveBeenCalledTimes(1);
    const [url, request] = state.request.mock.calls[0];
    expect(url).toBe('https://child-action-fixture.invalid/auth/v1/token?grant_type=password');
    expect(JSON.parse(request.body)).toEqual({ email: 'child.emma@kids.bubaly.app', password: deriveChildPassword('synthetic-child-derivation-fixture', 'emma', '1234'), gotrue_meta_security: {} });
    expect(state.options[0]).toMatchObject({ auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, skipAutoInitialize: true } });
    expect(state.upserts[0]).toMatchObject({ username: 'emma', fails: 0, locked_until: null });
    expect(JSON.stringify(result)).not.toContain('synthetic-child-derivation-fixture');
    expect(JSON.stringify(result)).not.toContain('child.emma@kids.bubaly.app');
  });

  it('retains cleaned public credential configuration', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', ' "https://child-action-fixture.invalid" \n');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', " 'synthetic-public-anon' \n");
    expect(await childSignInAction({ username: 'emma', pin: '1234' })).toMatchObject({ ok: true });
  });

  it('requires server-only child credentials before any lookup or provider request', async () => {
    vi.stubEnv('CHILD_LOGIN_SECRET', '');
    expect(await childSignInAction({ username: 'emma', pin: '1234' })).toEqual({ ok: false, error: 'actions.kidSignInIsnT' });
    expect(state.tables).toEqual([]); expect(state.request).not.toHaveBeenCalled();
  });

  it('preserves the IP-wide guard before child lookup', async () => {
    state.rateLimit.mockResolvedValue({ ok: false });
    expect(await childSignInAction({ username: 'emma', pin: '1234' })).toEqual({ ok: false, error: 'actions.tooManySignInAttempts' });
    expect(state.tables).toEqual([]); expect(state.request).not.toHaveBeenCalled();
  });

  it.each([{ username: '..', pin: '1234' }, { username: 'emma', pin: '123' }, { username: 'emma', pin: 'ab12' }])('validates username and PIN before password derivation (%j)', async input => {
    expect(await childSignInAction(input)).toEqual({ ok: false, error: 'actions.checkTheUsernameAndPin' });
    expect(state.tables).toEqual([]); expect(state.request).not.toHaveBeenCalled();
  });

  it.each(['throttle', 'lookup'] as const)('fails closed on a %s read failure', async kind => {
    if (kind === 'throttle') state.throttleError = { message: 'synthetic failure' };
    else state.lookupError = { message: 'synthetic failure' };
    expect(await childSignInAction({ username: 'emma', pin: '1234' })).toEqual({ ok: false, error: 'actions.kidSignInIsTemporarily' });
    expect(state.request).not.toHaveBeenCalled();
  });

  it('rejects the durable username lock before password verification', async () => {
    state.throttle = { fails: 20, window_start: new Date().toISOString(), locked_until: new Date(Date.now() + 600_000).toISOString() };
    expect(await childSignInAction({ username: 'emma', pin: '1234' })).toMatchObject({ ok: false });
    expect(state.request).not.toHaveBeenCalled();
  });

  it('keeps unknown usernames and rejected PINs indistinguishable and records both failures', async () => {
    state.unknown = true;
    const unknown = await childSignInAction({ username: 'emma', pin: '1234' });
    expect(state.request).not.toHaveBeenCalled();
    state.unknown = false; respond({ error_code: 'invalid_credentials', msg: 'Invalid login credentials' }, 400);
    const rejected = await childSignInAction({ username: 'emma', pin: '1234' });
    expect(unknown).toEqual({ ok: false, error: 'actions.thatUsernameOrPinIsn' });
    expect(rejected).toEqual(unknown);
    expect(state.upserts).toHaveLength(2);
    expect(state.upserts.every(value => value.fails === 1)).toBe(true);
  });

  it.each([true, false])('does not return an authentication candidate when failed-attempt persistence fails (unknown=%s)', async unknown => {
    state.unknown = unknown; state.writeError = { message: 'synthetic write failure' };
    respond({ error_code: 'invalid_credentials', msg: 'Invalid login credentials' }, 400);
    expect(await childSignInAction({ username: 'emma', pin: '1234' })).toEqual({ ok: false, error: 'actions.kidSignInIsTemporarily' });
  });

  it.each(['access_token', 'refresh_token'] as const)('rejects a blank %s rather than returning a usable-looking candidate', async field => {
    respond({ ...receipt(), [field]: '   ' });
    expect(await childSignInAction({ username: 'emma', pin: '1234' })).toEqual({ ok: false, error: 'actions.kidSignInIsTemporarily' });
  });

  it('rejects a provider receipt for a different child identity', async () => {
    const response = receipt(); response.user.id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'; respond(response);
    expect(await childSignInAction({ username: 'emma', pin: '1234' })).toEqual({ ok: false, error: 'actions.kidSignInIsTemporarily' });
    expect(state.upserts).toEqual([]);
  });

  it('does not return a different identity token hidden inside the expected child user receipt', async () => {
    const response = receipt();
    const parts = response.access_token.split('.');
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    payload.sub = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    parts[1] = Buffer.from(JSON.stringify(payload)).toString('base64url');
    response.access_token = parts.join('.'); respond(response);
    expect(await childSignInAction({ username: 'emma', pin: '1234' })).toEqual({ ok: false, error: 'actions.kidSignInIsTemporarily' });
    expect(state.upserts).toEqual([]);
  });

  it('sanitizes construction failures without leaking configuration in the action result', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
    expect(await childSignInAction({ username: 'emma', pin: '1234' })).toEqual({ ok: false, error: 'actions.kidSignInIsTemporarily' });
    expect(state.request).not.toHaveBeenCalled();
  });
});
