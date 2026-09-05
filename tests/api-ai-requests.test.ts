// POST /api/ai/requests — the Ask Bubaly entry (map P2-03).
//
// What is pinned here: the route authenticates like /api/ai, bounds the body
// (413), refuses a family whose `ai-requests` feature is off (404, and no
// request row is written) or below the tier (403), files the request under the
// caller's family, answers 202 with the plan-derived body BEFORE any execution
// (the continuation is a mocked `kickRun` that is handed the run id and an
// explicit budget), parks a clarification as an `awaiting_context` run, and
// answers 429 with Retry-After from the durable guard.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getUserContext = vi.fn();
const getBearerUserContext = vi.fn();
const ensureActiveFamily = vi.fn();
const isAIConfigured = vi.fn();
const rateLimit = vi.fn();
const rateLimitDb = vi.fn();
const getResolvedFeatureTiers = vi.fn();
const resolveFamilyPlanLevel = vi.fn();
const classifyIntent = vi.fn();
const buildContext = vi.fn();
const planRequest = vi.fn();
const kickRun = vi.fn();

type Call = { table: string; kind: 'select' | 'insert' | 'update' | 'delete' | 'upsert'; filters: Record<string, unknown>; payload?: unknown };
type Reply = { data: unknown; error: unknown };

/** A recording PostgREST stand-in: every call captures its table, verb, filters and payload. */
function makeDb(respond: (call: Call) => Reply) {
  const calls: Call[] = [];
  const from = (table: string) => {
    const call: Call = { table, kind: 'select', filters: {} };
    calls.push(call);
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    const filter = (column: string, value: unknown) => { call.filters[column] = value; return builder; };
    Object.assign(builder, {
      select: chain, order: chain, limit: chain,
      eq: filter, is: filter, gte: filter,
      in: (column: string, values: unknown) => filter(`in:${column}`, values),
      insert: (payload: unknown) => { call.kind = 'insert'; call.payload = payload; return builder; },
      update: (payload: unknown) => { call.kind = 'update'; call.payload = payload; return builder; },
      upsert: (payload: unknown) => { call.kind = 'upsert'; call.payload = payload; return builder; },
      delete: () => { call.kind = 'delete'; return builder; },
      single: () => Promise.resolve(respond(call)),
      maybeSingle: () => Promise.resolve(respond(call)),
      then: (resolve: (value: Reply) => void) => resolve(respond(call)),
    });
    return builder;
  };
  return { from, calls, auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) } };
}

const state: { conversation: Record<string, unknown> | null } = { conversation: { id: 'conv-1' } };
let cookieDb: ReturnType<typeof makeDb>;
let ledgerDb: ReturnType<typeof makeDb>;

function respond(call: Call): Reply {
  if (call.table === 'ai_requests' && call.kind === 'insert') return { data: { id: 'req-1' }, error: null };
  if (call.table === 'ai_requests' && call.kind === 'select') return { data: { id: 'req-1', clarifications: [] }, error: null };
  if (call.table === 'family_automation_runs' && call.kind === 'insert') return { data: { id: 'run-park' }, error: null };
  if (call.table === 'ai_conversations') return { data: state.conversation, error: null };
  return { data: null, error: null };
}

vi.mock('@/lib/supabase/server', () => ({
  createServer: async () => cookieDb,
  createServiceClient: () => ledgerDb,
}));
vi.mock('@/lib/supabase/auth', () => ({ getUserContext: () => getUserContext() }));
vi.mock('@/lib/supabase/bearer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/supabase/bearer')>()),
  getBearerUserContext: (token: string) => getBearerUserContext(token),
}));
vi.mock('@/lib/server/ensure-family', () => ({ ensureActiveFamily: (...a: unknown[]) => ensureActiveFamily(...a) }));
vi.mock('@/lib/ai/provider', () => ({ isAIConfigured: () => isAIConfigured() }));
vi.mock('@/lib/server/rate-limit', () => ({ rateLimit: (...a: unknown[]) => rateLimit(...a) }));
vi.mock('@/lib/server/rate-limit-db', () => ({ rateLimitDb: (...a: unknown[]) => rateLimitDb(...a) }));
vi.mock('@/lib/server/feature-tiers', () => ({ getResolvedFeatureTiers: (...a: unknown[]) => getResolvedFeatureTiers(...a) }));
vi.mock('@/lib/server/plan', () => ({ resolveFamilyPlanLevel: (...a: unknown[]) => resolveFamilyPlanLevel(...a) }));
vi.mock('@/lib/ai/context/intents', () => ({
  classifyIntent: (...a: unknown[]) => classifyIntent(...a),
  isIntentKey: (v: unknown) => typeof v === 'string',
}));
vi.mock('@/lib/ai/context/builder', () => ({ buildContext: (...a: unknown[]) => buildContext(...a) }));
vi.mock('@/lib/ai/planner', () => ({ planRequest: (...a: unknown[]) => planRequest(...a) }));
vi.mock('@/lib/ai/runs/continue', () => ({ kickRun: (...a: unknown[]) => kickRun(...a) }));

const ctx = {
  user: { id: 'user-1', email: 'parent@example.com' },
  memberships: [],
  active: { familyId: 'fam-1', role: 'parent', family: { name: 'Fam', timezone: 'America/Chicago' }, member: { id: 'member-1' } },
};

const CONTEXT_BUNDLE = { header: {}, slices: {}, stats: {}, sensitiveOmitted: [], text: 'ctx' };

function post(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/ai/requests', {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  cookieDb = makeDb(respond);
  ledgerDb = makeDb(respond);
  state.conversation = { id: 'conv-1' };
  getUserContext.mockResolvedValue(ctx);
  getBearerUserContext.mockResolvedValue({ ok: false, reason: 'invalid_token' });
  isAIConfigured.mockResolvedValue(true);
  rateLimit.mockReturnValue({ ok: true });
  rateLimitDb.mockResolvedValue({ ok: true });
  getResolvedFeatureTiers.mockResolvedValue({ 'ai-requests': 'basic' });
  resolveFamilyPlanLevel.mockResolvedValue(1);
  classifyIntent.mockResolvedValue({ intent: 'plan_week', confidence: 0.9, entities: {}, source: 'fast_path' });
  buildContext.mockResolvedValue({ ok: true, data: CONTEXT_BUNDLE });
  planRequest.mockResolvedValue({ ok: true, data: { kind: 'plan', planId: 'plan-1', runId: 'run-1', stepCount: 4, riskLevel: 'low', requiresApproval: false, summary: 'Planned the week.' } });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });

describe('POST /api/ai/requests — auth and limits', () => {
  it('401s anonymous callers before touching the database', async () => {
    getUserContext.mockResolvedValue(null);
    const { POST } = await import('@/app/api/ai/requests/route');
    const res = await POST(post({ text: 'Plan our week' }));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('signed_out');
    expect(cookieDb.calls).toHaveLength(0);
  });

  it('401s an invalid bearer token without falling back to cookies', async () => {
    const { POST } = await import('@/app/api/ai/requests/route');
    const res = await POST(post({ text: 'Plan our week' }, { authorization: 'Bearer nope' }));
    expect(res.status).toBe(401);
    expect(getBearerUserContext).toHaveBeenCalledWith('nope');
    expect(getUserContext).not.toHaveBeenCalled();
  });

  it('answers 429 with Retry-After from the durable guard', async () => {
    rateLimitDb.mockResolvedValue({ ok: false, retryAfter: 17 });
    const { POST } = await import('@/app/api/ai/requests/route');
    const res = await POST(post({ text: 'Plan our week' }));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('17');
    expect(planRequest).not.toHaveBeenCalled();
  });

  it('413s a body over the bound before parsing it', async () => {
    const { POST } = await import('@/app/api/ai/requests/route');
    const res = await POST(post({ text: 'x'.repeat(20_000) }));
    expect(res.status).toBe(413);
    expect(cookieDb.calls.filter((c) => c.table === 'ai_requests')).toHaveLength(0);
  });

  it('400s a body with no text', async () => {
    const { POST } = await import('@/app/api/ai/requests/route');
    const res = await POST(post({ text: '   ' }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('text_required');
  });
});

describe('POST /api/ai/requests — feature gate', () => {
  it('404s when the ai-requests feature is off, and writes nothing', async () => {
    getResolvedFeatureTiers.mockResolvedValue({ 'ai-requests': 'off' });
    const { POST } = await import('@/app/api/ai/requests/route');
    const res = await POST(post({ text: 'Plan our week' }));
    expect(res.status).toBe(404);
    expect(cookieDb.calls.filter((c) => c.kind === 'insert')).toHaveLength(0);
    expect(ledgerDb.calls.filter((c) => c.kind === 'insert')).toHaveLength(0);
    expect(planRequest).not.toHaveBeenCalled();
  });

  it('403s a family below the feature tier with the level it needs', async () => {
    getResolvedFeatureTiers.mockResolvedValue({ 'ai-requests': 'plus' });
    resolveFamilyPlanLevel.mockResolvedValue(1);
    const { POST } = await import('@/app/api/ai/requests/route');
    const res = await POST(post({ text: 'Plan our week' }));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'plan_required', needLevel: 2 });
  });

  it('503s when no provider is configured, unless the scripted provider is on', async () => {
    isAIConfigured.mockResolvedValue(false);
    const { POST } = await import('@/app/api/ai/requests/route');
    expect((await POST(post({ text: 'Plan our week' }))).status).toBe(503);
    process.env.AI_PROVIDER_STUB = '1';
    try {
      expect((await POST(post({ text: 'Plan our week' }))).status).toBe(202);
    } finally {
      delete process.env.AI_PROVIDER_STUB;
    }
  });
});

describe('POST /api/ai/requests — intake', () => {
  it('files the request under the caller\'s family and responds 202 with the run before execution', async () => {
    const { POST } = await import('@/app/api/ai/requests/route');
    const res = await POST(post({ text: 'Plan our week', context: { module: 'calendar' } }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({
      requestId: 'req-1', runId: 'run-1', planId: 'plan-1', outcome: 'plan',
      summary: 'Planned the week.', redirect: '/dashboard/concierge/runs/run-1',
    });

    // The request row is written through the caller's own client (RLS) with the family and the requester.
    const insert = cookieDb.calls.find((c) => c.table === 'ai_requests' && c.kind === 'insert');
    expect(insert?.payload).toMatchObject({ family_id: 'fam-1', requested_by: 'user-1', requested_by_member_id: 'member-1', kind: 'concierge', request_text: 'Plan our week', status: 'queued' });

    // The pipeline ran in order, against the same request, with the page context.
    expect(classifyIntent).toHaveBeenCalledTimes(1);
    expect(classifyIntent.mock.calls[0][1]).toBe('Plan our week');
    expect(classifyIntent.mock.calls[0][2]).toMatchObject({ pageContext: { module: 'calendar' } });
    expect(buildContext.mock.calls[0][1]).toMatchObject({ intent: 'plan_week', requestId: 'req-1' });
    expect(planRequest.mock.calls[0][0]).toMatchObject({ familyId: 'fam-1', requestId: 'req-1', actorKind: 'member' });
    expect(planRequest.mock.calls[0][1]).toMatchObject({ requestId: 'req-1', requestText: 'Plan our week', intent: 'plan_week', context: CONTEXT_BUNDLE, pageContext: { module: 'calendar' }, entities: {} });

    // The interpreted intent lands on the request; the status moved to planning.
    const updates = ledgerDb.calls.filter((c) => c.table === 'ai_requests' && c.kind === 'update').map((c) => c.payload as Record<string, unknown>);
    expect(updates.some((u) => u.status === 'planning')).toBe(true);
    expect(updates.some((u) => u.interpreted_intent === 'plan_week' && u.intent_confidence === 0.9)).toBe(true);

    // Execution is handed to the continuation with an explicit budget; the route never ran a step itself.
    expect(kickRun).toHaveBeenCalledTimes(1);
    expect(kickRun.mock.calls[0][0]).toBe('run-1');
    const budget = (kickRun.mock.calls[0][1] as { budgetMs: number }).budgetMs;
    expect(budget).toBeGreaterThanOrEqual(15_000);
    expect(budget).toBeLessThanOrEqual(240_000);
  });

  it('parks a clarification as an awaiting_context run with the question on the request', async () => {
    planRequest.mockResolvedValue({ ok: true, data: { kind: 'clarification', question: 'Which weekend — this one or next?', requestId: 'req-1' } });
    const { POST } = await import('@/app/api/ai/requests/route');
    const res = await POST(post({ text: 'Organize our weekend' }));
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ outcome: 'clarification', runId: 'run-park', planId: null, question: 'Which weekend — this one or next?', redirect: '/dashboard/concierge/runs/run-park' });

    const run = ledgerDb.calls.find((c) => c.table === 'family_automation_runs' && c.kind === 'insert');
    expect(run?.payload).toMatchObject({ family_id: 'fam-1', request_id: 'req-1', state: 'awaiting_context', summary: 'Which weekend — this one or next?' });
    // The planner appends the question to ai_requests.clarifications itself; intake must not write it twice.
    expect(ledgerDb.calls.some((c) => c.table === 'ai_requests' && c.kind === 'update' && 'clarifications' in (c.payload as Record<string, unknown>))).toBe(false);
    const event = ledgerDb.calls.find((c) => c.table === 'ai_run_events' && c.kind === 'insert');
    expect(event?.payload).toMatchObject({ run_id: 'run-park', event_type: 'clarification_asked', family_id: 'fam-1' });
    expect(kickRun).not.toHaveBeenCalled();
  });

  it('returns an answer inline, with no run and no execution', async () => {
    planRequest.mockResolvedValue({ ok: true, data: { kind: 'answer', text: 'Emma is free Saturday after 2pm.' } });
    const { POST } = await import('@/app/api/ai/requests/route');
    const res = await POST(post({ text: "Who's free Saturday?" }));
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ outcome: 'answer', runId: null, summary: 'Emma is free Saturday after 2pm.', redirect: null });
    expect(ledgerDb.calls.some((c) => c.table === 'family_automation_runs' && c.kind === 'insert')).toBe(false);
    expect(kickRun).not.toHaveBeenCalled();
  });

  it('404s a conversation the caller does not own and files nothing', async () => {
    state.conversation = null;
    const { POST } = await import('@/app/api/ai/requests/route');
    const res = await POST(post({ text: 'Plan our week', conversationId: '22222222-2222-4222-8222-222222222222' }));
    expect(res.status).toBe(404);
    const ownership = cookieDb.calls.find((c) => c.table === 'ai_conversations');
    expect(ownership?.filters).toMatchObject({ family_id: 'fam-1', user_id: 'user-1' });
    expect(cookieDb.calls.filter((c) => c.table === 'ai_requests')).toHaveLength(0);
  });

  it('links the exchange to an owned conversation through ai_messages.request_id', async () => {
    const { POST } = await import('@/app/api/ai/requests/route');
    const res = await POST(post({ text: 'Plan our week', conversationId: '22222222-2222-4222-8222-222222222222' }));
    expect(res.status).toBe(202);
    const messages = ledgerDb.calls.filter((c) => c.table === 'ai_messages' && c.kind === 'insert').map((c) => c.payload as Record<string, unknown>);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: 'user', request_id: 'req-1', family_id: 'fam-1', sender_member_id: 'member-1', content: 'Plan our week' });
    expect(messages[1]).toMatchObject({ role: 'assistant', request_id: 'req-1', content: 'Planned the week.', structured_content: { kind: 'run_status', runId: 'run-1' } });
  });

  it('marks the request failed and answers 504 when the planner exceeds its budget', async () => {
    planRequest.mockReturnValue(new Promise(() => {}));
    const { submitRequest } = await import('@/lib/ai/runs/intake');
    const scope = { db: cookieDb as never, familyId: 'fam-1', userId: 'user-1', memberId: 'member-1', role: 'parent' as const, actorKind: 'member' as const, tz: 'UTC' };
    const result = await submitRequest(scope, { text: 'Plan our week' }, { db: ledgerDb as never, plannerBudgetMs: 10, kick: kickRun });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('planner_timeout');
    const failed = ledgerDb.calls.find((c) => c.table === 'ai_requests' && c.kind === 'update' && (c.payload as Record<string, unknown>).status === 'failed');
    expect(failed?.payload).toMatchObject({ error: 'planner_timeout' });
    expect(kickRun).not.toHaveBeenCalled();

    const { statusForServiceCode } = await import('@/lib/ai/runs/intake');
    expect(statusForServiceCode('planner_timeout', true)).toBe(504);
  });

  it('marks the request failed when the context cannot be built, and never plans over a partial picture', async () => {
    buildContext.mockResolvedValue({ ok: false, error: 'Could not load the calendar.', code: 'db', retryable: true });
    const { POST } = await import('@/app/api/ai/requests/route');
    const res = await POST(post({ text: 'Plan our week' }));
    expect(res.status).toBe(503);
    expect(planRequest).not.toHaveBeenCalled();
    const failed = ledgerDb.calls.find((c) => c.table === 'ai_requests' && c.kind === 'update' && (c.payload as Record<string, unknown>).status === 'failed');
    expect(failed?.payload).toMatchObject({ error: 'Could not load the calendar.' });
  });
});

describe('route configuration', () => {
  it('runs on node with the long duration the continuation slice needs', async () => {
    const route = await import('@/app/api/ai/requests/route');
    expect(route.runtime).toBe('nodejs');
    expect(route.maxDuration).toBe(300);
  });
});
