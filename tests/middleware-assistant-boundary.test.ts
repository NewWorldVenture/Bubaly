import { createClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashAssistantToken } from '@/lib/assistant/link-token';

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(), admin: vi.fn(), answer: vi.fn(), record: vi.fn(),
  // Amazon's request signature is checked BEFORE the access token, so an
  // unsigned envelope never reaches the token logic this file is about. These
  // cases predate that check and would otherwise be asserting a contract the
  // route no longer has. Stubbed to "verified" so each one still tests what it
  // was written to test — and the last case below turns it off to pin the new
  // contract. What a real signature must satisfy is proved end to end against a
  // freshly minted certificate chain in tests/alexa-request-verification.ts.
  verifyAlexa: vi.fn(),
}));
vi.mock('@supabase/ssr', () => ({ createServerClient: () => ({ auth: { getUser: mocks.getUser } }) }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: mocks.admin }));
vi.mock('@/lib/assistant/service', async original => ({ ...await original<typeof import('@/lib/assistant/service')>(), answerAssistant: mocks.answer, recordAssistantEvent: mocks.record }));
vi.mock('@/lib/assistant/alexa-verify', async original => ({ ...await original<typeof import('@/lib/assistant/alexa-verify')>(), verifyAlexaRequest: mocks.verifyAlexa }));

const ORIGIN = 'https://assistant-middleware-fixture.invalid';
const TOKEN = `bub_asst_${'x'.repeat(43)}`;
const FAMILY = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const PATHS = ['/api/assistant', '/api/assistant/alexa'] as const;
let linkExists = false;
let reads: URL[];

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://assistant-db-fixture.invalid');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'synthetic-anon-key');
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Live transport prohibited'); }));
  mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
  mocks.answer.mockResolvedValue({ speech: 'Synthetic authorized answer', intent: 'help', outcome: 'answered' });
  mocks.record.mockResolvedValue(undefined);
  mocks.verifyAlexa.mockResolvedValue({ ok: true });
  linkExists = false; reads = [];
  const client = createClient('https://assistant-db-fixture.invalid', 'synthetic-service-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (raw, init = {}) => {
      const url = new URL(String(raw)); reads.push(url);
      expect(url.pathname).toBe('/rest/v1/assistant_links');
      expect(init.method ?? 'GET').toBe('GET');
      expect(url.searchParams.get('token_hash')).toBe(`eq.${hashAssistantToken(TOKEN)}`);
      expect(url.searchParams.get('revoked_at')).toBe('is.null');
      return Response.json(linkExists ? [{ id: USER, family_id: FAMILY, user_id: USER, provider: 'other', scopes: ['read'], revoked_at: null, families: { timezone: 'UTC' } }] : []);
    } },
  });
  mocks.admin.mockReturnValue(client);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

function request(path: string, token?: string, method = 'POST') {
  const alexa = path === '/api/assistant/alexa';
  const payload = alexa ? { request: { type: 'LaunchRequest' }, session: { user: { accessToken: token } } }
    : { utterance: '', token, familyId: 'untrusted-family' };
  return new NextRequest(`${ORIGIN}${path}`, { method, headers: { 'content-type': 'application/json' },
    ...(method === 'POST' ? { body: JSON.stringify(payload) } : {}) });
}
async function deliver(path: typeof PATHS[number], token?: string) {
  const req = request(path, token);
  const { middleware } = await import('@/middleware');
  const gate = await middleware(req);
  expect(gate.headers.get('x-middleware-next')).toBe('1');
  return path === '/api/assistant'
    ? (await import('@/app/api/assistant/route')).POST(req)
    : (await import('@/app/api/assistant/alexa/route')).POST(req);
}

describe('exact assistant middleware authorization boundary', () => {
  it.each(PATHS)('lets cookie-less POST %s reach its own token authorization', async path => {
    const { middleware } = await import('@/middleware');
    const gate = await middleware(request(path, TOKEN));
    expect(gate.status).toBe(200);
    expect(gate.headers.get('x-middleware-next')).toBe('1');
    expect(gate.headers.get('location')).toBeNull();
  });
  it.each(PATHS)('rejects a missing token in actual %s before service access', async path => {
    const response = await deliver(path);
    expect(response.status).toBe(path === '/api/assistant' ? 401 : 200);
    expect(mocks.admin).not.toHaveBeenCalled(); expect(reads).toEqual([]); expect(mocks.answer).not.toHaveBeenCalled(); expect(mocks.record).not.toHaveBeenCalled();
    if (path.endsWith('/alexa')) expect(await response.json()).toMatchObject({ response: { outputSpeech: { text: expect.stringContaining('link') } } });
  });
  it.each(PATHS)('rejects an unknown token in actual %s before answering or capturing data', async path => {
    const response = await deliver(path, TOKEN);
    expect(response.status).toBe(path === '/api/assistant' ? 401 : 200);
    expect(reads).toHaveLength(1); expect(mocks.answer).not.toHaveBeenCalled(); expect(mocks.record).not.toHaveBeenCalled();
  });
  it.each(PATHS)('uses the actual resolved token scope in %s without a cookie', async path => {
    linkExists = true;
    expect((await deliver(path, TOKEN)).status).toBe(200);
    expect(reads).toHaveLength(1);
    expect(mocks.answer).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ family_id: FAMILY, user_id: USER }), expect.anything());
    expect(mocks.record).toHaveBeenCalledOnce();
  });
  it.each(['/api/assistant/links', '/api/assistant/alexa/private', '/api/assistant-extra', '/api/assistants'])('keeps neighboring POST %s protected even with a bearer header', async path => {
    const { middleware } = await import('@/middleware');
    const req = request(path, TOKEN); req.headers.set('authorization', `Bearer ${TOKEN}`);
    const response = await middleware(req);
    expect(response.status).toBe(307); expect(new URL(response.headers.get('location')!).pathname).toBe('/login');
  });
  it.each(PATHS)('keeps non-POST methods on %s session-protected', async path => {
    const { middleware } = await import('@/middleware');
    expect((await middleware(request(path, undefined, 'GET'))).status).toBe(307);
    expect((await middleware(request(path, undefined, 'DELETE'))).status).toBe(307);
  });
  it('refuses an Alexa envelope that cannot be proved to come from Amazon, before any lookup', async () => {
    // The contract the stub above stands in for. Being routable is what makes
    // the assistant work; being unforgeable is what makes it safe to be
    // routable, and the two are decided in that order.
    mocks.verifyAlexa.mockResolvedValue({ ok: false, reason: 'missing_signature' });
    const response = await deliver('/api/assistant/alexa', TOKEN);
    expect(response.status).toBe(403);
    // No speech either: there is no device on the other end of a forged
    // request, and a spoken reply would confirm the endpoint is live.
    expect(await response.text()).toBe('');
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(reads).toEqual([]);
    expect(mocks.answer).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });
  it('leaves the token endpoint alone: it has no signature to check', async () => {
    mocks.verifyAlexa.mockResolvedValue({ ok: false, reason: 'missing_signature' });
    expect((await deliver('/api/assistant', TOKEN)).status).toBe(401);
    expect(reads).toHaveLength(1);
  });
  it('preserves the exact POST boundary when Supabase session configuration is missing', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', ''); vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', '');
    const { middleware } = await import('@/middleware');
    for (const path of PATHS) expect((await middleware(request(path, TOKEN))).headers.get('x-middleware-next')).toBe('1');
    expect((await middleware(request('/api/assistant/settings', TOKEN))).status).toBe(307);
  });
});
