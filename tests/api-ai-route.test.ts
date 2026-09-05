import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getUserContext = vi.fn();
const getBearerUserContext = vi.fn();
const ensureActiveFamily = vi.fn();
const isAIConfigured = vi.fn();
const prepareAssistantTurn = vi.fn();
const runAssistantTurn = vi.fn();
const createAssistantStream = vi.fn();
const rateLimit = vi.fn();
const rateLimitDb = vi.fn();

vi.mock('@/lib/supabase/server', () => ({ createServer: async () => cookieClient }));
vi.mock('@/lib/supabase/auth', () => ({ getUserContext: () => getUserContext() }));
vi.mock('@/lib/supabase/bearer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/supabase/bearer')>()),
  getBearerUserContext: (token: string) => getBearerUserContext(token),
}));
vi.mock('@/lib/server/ensure-family', () => ({ ensureActiveFamily: (...a: unknown[]) => ensureActiveFamily(...a) }));
vi.mock('@/lib/ai/provider', () => ({
  isAIConfigured: () => isAIConfigured(),
  describeAIError: (e: unknown) => ({ code: 'x', message: e instanceof Error ? e.message : String(e), detail: '' }),
}));
vi.mock('@/lib/server/rate-limit', () => ({ rateLimit: (...a: unknown[]) => rateLimit(...a) }));
vi.mock('@/lib/server/rate-limit-db', () => ({ rateLimitDb: (...a: unknown[]) => rateLimitDb(...a) }));
vi.mock('@/lib/assistant/tools', () => ({
  buildAssistantTools: () => [{ name: 'add_chore', description: 'Add a chore', input_schema: { type: 'object' }, execute: async () => ({}) }],
}));
vi.mock('@/lib/ai/actions', () => ({
  AI_TOOLS: [
    { name: 'add_chore', description: 'dup', input_schema: { type: 'object' } },
    { name: 'create_meal_plan_entry', description: 'Plan a meal', input_schema: { type: 'object' } },
  ],
  runAction: async () => ({ ok: true }),
}));
vi.mock('@/lib/ai/assistant-engine', async (importOriginal) => ({
  wantsJsonTransport: (await importOriginal<typeof import('@/lib/ai/assistant-engine')>()).wantsJsonTransport,
  SSE_HEADERS: { 'Content-Type': 'text/event-stream; charset=utf-8' },
  prepareAssistantTurn: (...a: unknown[]) => prepareAssistantTurn(...a),
  runAssistantTurn: (...a: unknown[]) => runAssistantTurn(...a),
  createAssistantStream: (...a: unknown[]) => createAssistantStream(...a),
}));

type Row = Record<string, unknown>;
const conv: { single?: Row | null; readError?: unknown; upsertError?: unknown } = {};
function client() {
  const c: Record<string, unknown> = {
    upsert: () => Promise.resolve({ error: conv.upsertError ?? null }),
    select: () => c, eq: () => c,
    maybeSingle: () => Promise.resolve({ data: conv.single === undefined ? { id: 'conv' } : conv.single, error: conv.readError ?? null }),
  };
  return { from: () => c, auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) } };
}
const cookieClient = client();
const bearerClient = client();

const CONVERSATION = '22222222-2222-4222-8222-222222222222';
const ctx = { user: { id: 'user-1', email: 'a@b.c' }, memberships: [], active: { familyId: 'fam-1', role: 'parent', family: { name: 'Fam', timezone: 'America/Chicago' } } };

function post(body: unknown, headers: Record<string, string> = {}, query = '') {
  return new NextRequest(`http://localhost/api/ai${query}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
}

beforeEach(() => {
  conv.single = undefined; conv.readError = undefined; conv.upsertError = undefined;
  getUserContext.mockResolvedValue(null);
  getBearerUserContext.mockResolvedValue({ ok: false, reason: 'invalid_token' });
  isAIConfigured.mockResolvedValue(true);
  rateLimit.mockReturnValue({ ok: true });
  rateLimitDb.mockResolvedValue({ ok: true });
  prepareAssistantTurn.mockResolvedValue({ ok: true, turn: { system: 's', messages: [], tools: [], provider: { model: 'm' } } });
  runAssistantTurn.mockResolvedValue({ content: 'Planned.', actions: [{ name: 'create_meal_plan_entry', ok: true, summary: 'Planned.' }], persisted: true, model: 'm' });
  createAssistantStream.mockReturnValue(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"type":"done"}\n\n')); c.close(); } }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });

describe('POST /api/ai auth', () => {
  it('401s anonymous callers with no session and no bearer token', async () => {
    const { POST } = await import('@/app/api/ai/route');
    const res = await POST(post({ conversationId: CONVERSATION, message: 'hi' }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Sign in to use the assistant.', code: 'signed_out' });
  });

  it('401s an invalid bearer token and never falls back to cookies', async () => {
    getUserContext.mockResolvedValue(ctx);
    const { POST } = await import('@/app/api/ai/route');
    const res = await POST(post({ conversationId: CONVERSATION, message: 'hi' }, { authorization: 'Bearer nope' }));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('invalid_token');
    expect(getBearerUserContext).toHaveBeenCalledWith('nope');
    expect(getUserContext).not.toHaveBeenCalled();
  });

  it('403s a bearer user with no family, and auto-provisions the cookie user instead', async () => {
    getBearerUserContext.mockResolvedValue({ ok: false, reason: 'needs_family' });
    const { POST } = await import('@/app/api/ai/route');
    const res = await POST(post({ conversationId: CONVERSATION, message: 'hi' }, { authorization: 'Bearer tok' }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('needs_family');

    getUserContext.mockResolvedValueOnce({ needsFamily: true }).mockResolvedValueOnce(ctx);
    ensureActiveFamily.mockResolvedValue(true);
    const cookieRes = await POST(post({ conversationId: CONVERSATION, message: 'hi' }, { accept: 'application/json' }));
    expect(cookieRes.status).toBe(200);
    expect(ensureActiveFamily).toHaveBeenCalled();
  });
});

describe('POST /api/ai transports', () => {
  it('returns one JSON result for bearer callers asking for application/json, scoped to their family', async () => {
    getBearerUserContext.mockResolvedValue({ ok: true, supabase: bearerClient, ctx });
    const { POST } = await import('@/app/api/ai/route');
    const res = await POST(post({ conversationId: CONVERSATION, message: 'Plan tacos' }, { authorization: 'Bearer tok', accept: 'application/json' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      conversationId: CONVERSATION, content: 'Planned.', actions: [{ name: 'create_meal_plan_entry', ok: true, summary: 'Planned.' }], persisted: true, model: 'm',
    });
    expect(prepareAssistantTurn).toHaveBeenCalledWith(expect.objectContaining({
      supabase: bearerClient, familyId: 'fam-1', userId: 'user-1', role: 'parent', familyName: 'Fam', tz: 'America/Chicago',
      conversationId: CONVERSATION, message: 'Plan tacos',
    }));
    expect(rateLimit).toHaveBeenCalledWith('ai-chat:user-1', { limit: 20, windowMs: 60_000 });
    expect(createAssistantStream).not.toHaveBeenCalled();
  });

  it('streams SSE by default for the web client', async () => {
    getUserContext.mockResolvedValue(ctx);
    const { POST } = await import('@/app/api/ai/route');
    const res = await POST(post({ conversationId: CONVERSATION, message: 'hi' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(await res.text()).toContain('"type":"done"');
    expect(runAssistantTurn).not.toHaveBeenCalled();
  });

  it('honours ?mode=json and stream:false for cookie users too', async () => {
    getUserContext.mockResolvedValue(ctx);
    const { POST } = await import('@/app/api/ai/route');
    expect((await POST(post({ conversationId: CONVERSATION, message: 'hi' }, {}, '?mode=json'))).headers.get('content-type')).toContain('application/json');
    expect((await POST(post({ conversationId: CONVERSATION, message: 'hi', stream: false }))).headers.get('content-type')).toContain('application/json');
  });
});

describe('POST /api/ai guards', () => {
  beforeEach(() => getUserContext.mockResolvedValue(ctx));

  it('validates the body', async () => {
    const { POST } = await import('@/app/api/ai/route');
    expect((await POST(post({ message: 'hi' }))).status).toBe(400);
    expect((await POST(post({ conversationId: 'nope', message: 'hi' }))).status).toBe(400);
    const res = await POST(post({ conversationId: CONVERSATION, message: '' }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('message_required');
  });

  it('rate limits before touching the engine', async () => {
    rateLimit.mockReturnValue({ ok: false, retryAfter: 12 });
    const { POST } = await import('@/app/api/ai/route');
    const res = await POST(post({ conversationId: CONVERSATION, message: 'hi' }));
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('12');
    expect(prepareAssistantTurn).not.toHaveBeenCalled();
  });

  it('503s when the AI engine is not configured', async () => {
    isAIConfigured.mockResolvedValue(false);
    const { POST } = await import('@/app/api/ai/route');
    const res = await POST(post({ conversationId: CONVERSATION, message: 'hi' }));
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('not_configured');
  });

  it('404s a conversation the caller does not own and 503s a failed ownership read', async () => {
    const { POST } = await import('@/app/api/ai/route');
    conv.single = null;
    expect((await POST(post({ conversationId: CONVERSATION, message: 'hi' }))).status).toBe(404);
    conv.single = undefined; conv.readError = { message: 'boom' };
    expect((await POST(post({ conversationId: CONVERSATION, message: 'hi' }))).status).toBe(503);
    expect(prepareAssistantTurn).not.toHaveBeenCalled();
  });

  it('500s with the engine error when context preparation fails', async () => {
    prepareAssistantTurn.mockResolvedValue({ ok: false, error: 'Could not load the family assistant context.' });
    const { POST } = await import('@/app/api/ai/route');
    const res = await POST(post({ conversationId: CONVERSATION, message: 'hi' }));
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('Could not load the family assistant context.');
  });
});

describe('GET /api/ai', () => {
  it('describes transports, auth, and the merged tool set', async () => {
    getBearerUserContext.mockResolvedValue({ ok: true, supabase: bearerClient, ctx });
    const { GET } = await import('@/app/api/ai/route');
    const res = await GET(new NextRequest('http://localhost/api/ai', { headers: { authorization: 'Bearer tok' } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ endpoint: '/api/ai', transports: ['sse', 'json'], auth: ['cookie', 'bearer'], configured: true, family: { id: 'fam-1', name: 'Fam' } });
    expect(body.tools).toEqual([
      { name: 'add_chore', description: 'Add a chore' },
      { name: 'create_meal_plan_entry', description: 'Plan a meal' },
    ]);
  });

  it('requires auth', async () => {
    const { GET } = await import('@/app/api/ai/route');
    expect((await GET(new NextRequest('http://localhost/api/ai'))).status).toBe(401);
  });
});

describe('wantsJsonTransport', () => {
  it('prefers SSE unless JSON is asked for explicitly', async () => {
    const { wantsJsonTransport } = await import('@/lib/ai/assistant-engine');
    const req = (accept?: string, query = '') => ({ headers: new Headers(accept ? { accept } : {}), nextUrl: { searchParams: new URLSearchParams(query) } });
    expect(wantsJsonTransport(req(), {})).toBe(false);
    expect(wantsJsonTransport(req('*/*'), {})).toBe(false);
    expect(wantsJsonTransport(req('application/json'), {})).toBe(true);
    expect(wantsJsonTransport(req('text/event-stream, application/json'), {})).toBe(false);
    expect(wantsJsonTransport(req(), { stream: false })).toBe(true);
    expect(wantsJsonTransport(req(undefined, 'mode=json'), {})).toBe(true);
  });
});
