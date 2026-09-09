import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// M19 — the voice routes were cookie-only, so the Expo app (which carries
// `Authorization: Bearer <supabase jwt>`) got a redirect-shaped 500 instead of
// a transcript. They now use the SAME resolver /api/ai does. These lock in the
// three answers that matter: bearer works, anonymous is 401, and a workspace
// with no transcription key gets an honest 503 — never a fabricated transcript
// or a silent empty one.

const getUserContext = vi.fn();
const getBearerUserContext = vi.fn();
const ensureActiveFamily = vi.fn();
const getOpenAIKey = vi.fn();
const enforceAIRateLimit = vi.fn();
const fetchExternal = vi.fn();

const cookieClient = { from: () => cookieClient, auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) } } as Record<string, unknown>;
const bearerClient = { from: () => bearerClient } as Record<string, unknown>;

vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => cookieClient }));
vi.mock('@/lib/supabase/auth', () => ({ getUserContext: () => getUserContext() }));
vi.mock('@/lib/supabase/bearer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/supabase/bearer')>()),
  getBearerUserContext: (token: string) => getBearerUserContext(token),
}));
vi.mock('@/lib/server/ensure-family', () => ({ ensureActiveFamily: (...a: unknown[]) => ensureActiveFamily(...a) }));
// ai-access also carries the plan gate, whose tier store is request-`cache`d;
// the routes only use its authenticator, so the store is stubbed away here.
vi.mock('@/lib/server/feature-tiers', () => ({
  getResolvedFeatureTiers: async () => ({ 'ai-requests': 'free' }),
  getFeatureTiersByHref: async () => ({}),
}));
vi.mock('@/lib/ai/settings', () => ({ getOpenAIKey: (...a: unknown[]) => getOpenAIKey(...a) }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: (...a: unknown[]) => enforceAIRateLimit(...a) }));
vi.mock('@/lib/server/external-fetch', () => ({ fetchExternal: (...a: unknown[]) => fetchExternal(...a) }));

const ctx = {
  user: { id: 'user-1', email: 'parent@example.com' },
  memberships: [],
  active: { familyId: 'fam-1', role: 'parent', family: { name: 'Fam', timezone: 'America/Chicago' } },
};

function audioForm() {
  const form = new FormData();
  form.append('audio', new Blob([new Uint8Array(2048)], { type: 'audio/webm' }), 'speech.webm');
  return form;
}

function transcribeRequest(headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/ai/voice/transcribe', { method: 'POST', headers, body: audioForm() });
}

function speakRequest(headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/ai/voice/speak', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ text: 'Dinner is planned.' }),
  });
}

beforeEach(() => {
  getUserContext.mockResolvedValue(null);
  getBearerUserContext.mockResolvedValue({ ok: false, reason: 'invalid_token' });
  getOpenAIKey.mockResolvedValue('sk-test');
  enforceAIRateLimit.mockResolvedValue({ ok: true });
  fetchExternal.mockResolvedValue(new Response(JSON.stringify({ text: 'Plan dinners for the week' }), { status: 200, headers: { 'content-type': 'application/json' } }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });

describe('POST /api/ai/voice/transcribe', () => {
  it('401s an anonymous caller with JSON, not a redirect', async () => {
    const { POST } = await import('@/app/api/ai/voice/transcribe/route');
    const res = await POST(transcribeRequest());
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('signed_out');
    expect(fetchExternal).not.toHaveBeenCalled();
  });

  it('accepts a bearer JWT and transcribes under that caller', async () => {
    getBearerUserContext.mockResolvedValue({ ok: true, supabase: bearerClient, ctx, user: ctx.user });
    const { POST } = await import('@/app/api/ai/voice/transcribe/route');
    const res = await POST(transcribeRequest({ authorization: 'Bearer token-abc' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: 'Plan dinners for the week' });
    expect(getBearerUserContext).toHaveBeenCalledWith('token-abc');
    // The bearer caller's own RLS client is what the key and limiter see.
    expect(getOpenAIKey).toHaveBeenCalledWith(bearerClient);
    expect(enforceAIRateLimit).toHaveBeenCalledWith(bearerClient, 'ai-voice-transcribe:user-1', { limit: 10 });
  });

  it('still accepts the browser cookie session', async () => {
    getUserContext.mockResolvedValue(ctx);
    const { POST } = await import('@/app/api/ai/voice/transcribe/route');
    const res = await POST(transcribeRequest());
    expect(res.status).toBe(200);
    expect(getOpenAIKey).toHaveBeenCalledWith(cookieClient);
  });

  it('401s an invalid bearer token instead of falling back to cookies', async () => {
    getUserContext.mockResolvedValue(ctx);
    getBearerUserContext.mockResolvedValue({ ok: false, reason: 'invalid_token' });
    const { POST } = await import('@/app/api/ai/voice/transcribe/route');
    const res = await POST(transcribeRequest({ authorization: 'Bearer stale' }));
    expect(res.status).toBe(401);
    expect(fetchExternal).not.toHaveBeenCalled();
  });

  it('503s with no transcription key, and never invents a transcript', async () => {
    getBearerUserContext.mockResolvedValue({ ok: true, supabase: bearerClient, ctx, user: ctx.user });
    getOpenAIKey.mockResolvedValue(null);
    const { POST } = await import('@/app/api/ai/voice/transcribe/route');
    const res = await POST(transcribeRequest({ authorization: 'Bearer token-abc' }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.code).toBe('not_configured');
    expect(body.text).toBeUndefined();
    expect(fetchExternal).not.toHaveBeenCalled();
  });

  it('a family that is not set up yet gets 403, not a transcript', async () => {
    getBearerUserContext.mockResolvedValue({ ok: false, reason: 'needs_family' });
    const { POST } = await import('@/app/api/ai/voice/transcribe/route');
    const res = await POST(transcribeRequest({ authorization: 'Bearer token-abc' }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('needs_family');
  });
});

describe('POST /api/ai/voice/speak', () => {
  it('401s an anonymous caller', async () => {
    const { POST } = await import('@/app/api/ai/voice/speak/route');
    const res = await POST(speakRequest());
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('signed_out');
    expect(fetchExternal).not.toHaveBeenCalled();
  });

  it('accepts a bearer JWT and streams the audio back', async () => {
    getBearerUserContext.mockResolvedValue({ ok: true, supabase: bearerClient, ctx, user: ctx.user });
    fetchExternal.mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const { POST } = await import('@/app/api/ai/voice/speak/route');
    const res = await POST(speakRequest({ authorization: 'Bearer token-abc' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('audio/mpeg');
    expect(enforceAIRateLimit).toHaveBeenCalledWith(bearerClient, 'ai-voice-speak:user-1', { limit: 30 });
  });

  it('503s with no speech key rather than returning a silent clip', async () => {
    getUserContext.mockResolvedValue(ctx);
    getOpenAIKey.mockResolvedValue(null);
    const { POST } = await import('@/app/api/ai/voice/speak/route');
    const res = await POST(speakRequest());
    expect(res.status).toBe(503);
    expect(res.headers.get('Content-Type')).toContain('application/json');
    expect((await res.json()).code).toBe('not_configured');
    expect(fetchExternal).not.toHaveBeenCalled();
  });
});

describe.each([
  ['transcribe', transcribeRequest, () => import('@/app/api/ai/voice/transcribe/route')],
  ['speak', speakRequest, () => import('@/app/api/ai/voice/speak/route')],
] as const)('%s household assertions', (_name, request, route) => {
  const FAMILY = 'aaaaaaaa-1111-4111-8111-111111111111';
  const OTHER_FAMILY = 'bbbbbbbb-2222-4222-8222-222222222222';
  const scoped = { ...ctx, active: { ...ctx.active, familyId: FAMILY } };

  it.each([
    ['', 400, 'invalid_family'],
    ['not-a-family', 400, 'invalid_family'],
    [FAMILY + ', ' + OTHER_FAMILY, 400, 'invalid_family'],
    [OTHER_FAMILY, 409, 'family_changed'],
  ])('rejects header %s before reading configuration or sending audio/text', async (expected, status, code) => {
    getBearerUserContext.mockResolvedValue({ ok: true, supabase: bearerClient, ctx: scoped, user: ctx.user });
    const { POST } = await route();
    const response = await POST(request({ authorization: 'Bearer tok', 'X-Bubaly-Family-Id': expected }));
    expect(response.status).toBe(status);
    expect((await response.json()).code).toBe(code);
    expect(enforceAIRateLimit).not.toHaveBeenCalled();
    expect(getOpenAIKey).not.toHaveBeenCalled();
    expect(fetchExternal).not.toHaveBeenCalled();
  });

  it('accepts a matching family UUID', async () => {
    getBearerUserContext.mockResolvedValue({ ok: true, supabase: bearerClient, ctx: scoped, user: ctx.user });
    const { POST } = await route();
    const response = await POST(request({ authorization: 'Bearer tok', 'X-Bubaly-Family-Id': FAMILY.toUpperCase() }));
    expect(response.status).toBe(200);
    expect(fetchExternal).toHaveBeenCalledOnce();
  });

  it('also checks cookie clients', async () => {
    getUserContext.mockResolvedValue(scoped);
    const { POST } = await route();
    const response = await POST(request({ 'X-Bubaly-Family-Id': OTHER_FAMILY }));
    expect(response.status).toBe(409);
    expect(fetchExternal).not.toHaveBeenCalled();
  });

  it('uses the bearer-selected language despite the geo header', async () => {
    getBearerUserContext.mockResolvedValue({ ok: true, supabase: bearerClient, ctx: scoped, user: ctx.user });
    const { POST } = await route();
    const response = await POST(request({
      authorization: 'Bearer tok', 'X-Bubaly-Family-Id': OTHER_FAMILY,
      'Accept-Language': 'fr-FR', 'x-vercel-ip-country': 'US',
    }));
    expect(await response.json()).toEqual({
      code: 'family_changed', error: 'Votre foyer actif a changé. Revenez à l’assistant et réessayez.',
    });
  });

  it('preserves unavailable authentication rather than treating it as missing voice configuration', async () => {
    getBearerUserContext.mockResolvedValue({ ok: false, reason: 'unavailable' });
    const { POST } = await route();
    const response = await POST(request({ authorization: 'Bearer tok', 'X-Bubaly-Family-Id': FAMILY }));
    expect(response.status).toBe(503);
    expect((await response.json()).code).toBe('unavailable');
    expect(getOpenAIKey).not.toHaveBeenCalled();
    expect(fetchExternal).not.toHaveBeenCalled();
  });
});
