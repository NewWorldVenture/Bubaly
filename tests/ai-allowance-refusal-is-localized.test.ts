import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

// F19 / I18N: the monthly AI allowance refusal (429 `allowance_exceeded`) was
// built in English only, and both clients show the server's text — the web
// assistant prints `err.error`, the native app prints the server copy for
// `allowance_exceeded`. So a German family at 10 of 10 read English.
//
// This drives the real allowance check, the real response helpers, the real
// request translators (`getTranslations` via next/headers, and
// `getAIRequestTranslations` for the bearer client) and the real catalogues,
// through two real routes and the helpers directly. Only identity, plan/tier
// settings, rate limits and the model are fixed. The count is 10 of Free's 10.

const ENGLISH = 'Your family has used its 10 AI requests for this month. Upgrade to Family Basic for unlimited, or try again next month.';
const GERMAN = 'Ihre Familie hat ihre 10 KI-Anfragen für diesen Monat aufgebraucht. Wechseln Sie zu Family Basic für unbegrenzte Anfragen oder versuchen Sie es nächsten Monat erneut.';

const state = vi.hoisted(() => ({
  used: 10,
  cookie: undefined as string | undefined,
  headers: {} as Record<string, string>,
}));

const ctx = {
  user: { id: 'user-1', email: 'parent@example.com' },
  memberships: [],
  active: { familyId: 'fam-1', role: 'parent', member: { id: 'member-1' }, family: { name: 'Fam', timezone: 'UTC' } },
};

/** Answers the allowance's head count on `ai_requests` with `state.used`. */
function client() {
  const chain: Record<string, unknown> = {
    select: () => chain, eq: () => chain, gte: () => chain,
    then: (ok: (v: unknown) => unknown) => ok({ data: null, error: null, count: state.used }),
  };
  return { from: () => chain, auth: { getUser: async () => ({ data: { user: ctx.user } }) } };
}
const db = client();

const prepareAssistantTurn = vi.fn();
const complete = vi.fn();

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (name === 'bubaly-locale' && state.cookie ? { value: state.cookie } : undefined) }),
  headers: async () => new Headers(state.headers),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => db, createServiceClient: () => db }));
vi.mock('@/lib/supabase/auth', () => ({ getUserContext: async () => ctx, requireUserContext: async () => ctx }));
vi.mock('@/lib/supabase/bearer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/supabase/bearer')>()),
  getBearerUserContext: async () => ({ ok: true, supabase: db, ctx }),
}));
vi.mock('@/lib/server/ensure-family', () => ({ ensureActiveFamily: async () => true }));
vi.mock('@/lib/server/route-feature-gate', () => ({ refuseUnlessEntitled: async () => null }));
vi.mock('@/lib/server/rate-limit', () => ({ rateLimit: () => ({ ok: true }) }));
vi.mock('@/lib/server/rate-limit-db', () => ({ rateLimitDb: async () => ({ ok: true }) }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/server/feature-tiers', () => ({
  getResolvedFeatureTiers: async () => ({ 'ai-assistant': 'free', 'ai-requests': 'basic' }),
  getFeatureTiersByHref: async () => ({}),
}));
vi.mock('@/lib/server/plan', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/plan')>()),
  resolveFamilyPlanLevel: async () => 0,
}));
vi.mock('@/lib/ai/provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/provider')>()),
  isAIConfigured: async () => true,
  resolveProvider: async () => ({ complete }),
}));
vi.mock('@/lib/ai/assistant-engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/assistant-engine')>()),
  prepareAssistantTurn: (...a: unknown[]) => prepareAssistantTurn(...a),
}));

// The first import parses every catalogue; give it room on a cold cache.
vi.setConfig({ testTimeout: 20_000 });

const CONVERSATION = '22222222-2222-4222-8222-222222222222';
function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost${url}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
}

beforeEach(() => {
  state.used = 10;
  state.cookie = undefined;
  state.headers = {};
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

describe('/api/ai — the assistant the web and the native app both call', () => {
  it('refuses a German web reader at 10 of 10 in German, with the cap in the body', async () => {
    state.cookie = 'de-DE';
    const { POST } = await import('@/app/api/ai/route');
    const res = await POST(post('/api/ai', { conversationId: CONVERSATION, message: 'hi' }));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body).toEqual({ error: GERMAN, code: 'allowance_exceeded', limit: 10 });
    expect(prepareAssistantTurn).not.toHaveBeenCalled();
  });

  it('refuses the native app in the language it asked for, over the edge geo guess', async () => {
    // The bearer client sends its chosen language; geo says US. The app wins.
    state.headers = { 'x-vercel-ip-country': 'US', 'accept-language': 'de-DE' };
    const { POST } = await import('@/app/api/ai/route');
    const res = await POST(post('/api/ai', { conversationId: CONVERSATION, message: 'hi' }, {
      authorization: 'Bearer token-abc', 'accept-language': 'de-DE', 'x-vercel-ip-country': 'US',
    }));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: GERMAN, code: 'allowance_exceeded', limit: 10 });
  });

  it('keeps the English refusal for an English reader', async () => {
    state.cookie = 'en-US';
    const { POST } = await import('@/app/api/ai/route');
    const res = await POST(post('/api/ai', { conversationId: CONVERSATION, message: 'hi' }));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: ENGLISH, code: 'allowance_exceeded', limit: 10 });
  });
});

describe('a route behind refuseOverAIAllowance (/api/ai/notes)', () => {
  it('refuses in the request locale without the route passing a translator', async () => {
    state.cookie = 'de-DE';
    const { POST } = await import('@/app/api/ai/notes/route');
    const res = await POST(post('/api/ai/notes', { content: 'Buy milk' }));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: GERMAN, code: 'allowance_exceeded', limit: 10 });
    expect(complete).not.toHaveBeenCalled();
  });

  it('still answers in English for an English reader', async () => {
    const { POST } = await import('@/app/api/ai/notes/route');
    const res = await POST(post('/api/ai/notes', { content: 'Buy milk' }));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: ENGLISH, code: 'allowance_exceeded', limit: 10 });
  });
});

describe('the helpers', () => {
  it('assertAIAllowance names the cap; accessDeniedResponse renders it per translator', async () => {
    const { assertAIAllowance, accessDeniedResponse } = await import('@/lib/server/ai-access');
    const { getMessages, translate } = await import('@/lib/i18n/messages');
    const denial = await assertAIAllowance(ctx as never, { db: db as never });
    expect(denial).toMatchObject({ ok: false, status: 429, code: 'allowance_exceeded', limit: 10, error: ENGLISH });
    if (denial.ok) throw new Error('expected a denial');

    const de = getMessages('de-DE');
    const german = accessDeniedResponse(denial, (k, p) => translate(de, k, p));
    expect(german.status).toBe(429);
    expect(await german.json()).toEqual({ error: GERMAN, code: 'allowance_exceeded', limit: 10 });

    // No translator: exactly the text the denial carries, as before.
    expect(await accessDeniedResponse(denial).json()).toEqual({ error: ENGLISH, code: 'allowance_exceeded', limit: 10 });
  });

  it('every catalogue words the refusal with the cap in it', async () => {
    const { getMessages, translate } = await import('@/lib/i18n/messages');
    for (const code of ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT']) {
      const messages = getMessages(code as never);
      expect(messages['ai.yourFamilyUsedItsMonthlyAllowance'], code).toBeTruthy();
      const text = translate(messages, 'ai.yourFamilyUsedItsMonthlyAllowance', { limit: 7 });
      expect(text, code).toContain('7');
      expect(text, code).not.toContain('{limit}');
    }
  });

  it('leaves the other denials alone even when a translator is supplied', async () => {
    const { accessDeniedResponse } = await import('@/lib/server/ai-access');
    const t = () => 'TRANSLATED';
    const res = accessDeniedResponse({ ok: false, status: 403, code: 'plan_required', needLevel: 1, error: 'Ask Bubaly is part of Family Basic.' }, t);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'Ask Bubaly is part of Family Basic.', code: 'plan_required', needLevel: 1 });
  });
});
