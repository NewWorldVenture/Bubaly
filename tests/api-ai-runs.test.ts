// /api/ai/runs/[id] and its controls (map P2-03).
//
// Pinned here: the detail read is family-scoped and a run from another family
// is a 404 (never a 403 that confirms the id); `answer` records the reply on
// the request, re-plans the SAME request, attaches the new plan to the SAME
// run — retiring the planner's fresh run with a guarded delete — and kicks the
// continuation; when the cron already claimed the planner's run the person is
// sent there instead and nothing runs twice; the controls map service codes
// to statuses and resume kicks the continuation.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getUserContext = vi.fn();
const buildContext = vi.fn();
const planRequest = vi.fn();
const kickRun = vi.fn();
const pauseRun = vi.fn();
const resumeRun = vi.fn();
const cancelRun = vi.fn();
const rerunStep = vi.fn();

type Call = { table: string; kind: 'select' | 'insert' | 'update' | 'delete'; filters: Record<string, unknown>; payload?: unknown };
type Reply = { data: unknown; error: unknown };

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
      delete: () => { call.kind = 'delete'; return builder; },
      single: () => Promise.resolve(respond(call)),
      maybeSingle: () => Promise.resolve(respond(call)),
      then: (resolve: (value: Reply) => void) => resolve(respond(call)),
    });
    return builder;
  };
  return { from, calls, auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) } };
}

const RUN = {
  id: 'run-1', family_id: 'fam-1', plan_id: null, request_id: 'req-1', requested_by_member_id: 'member-2',
  state: 'awaiting_context', status: 'pending', summary: 'Which weekend?', attempt: 0, max_attempts: 5,
  cancel_requested_at: null, paused_at: null, lease_owner: null, lease_expires_at: null,
};
const REQUEST = {
  id: 'req-1', family_id: 'fam-1', request_text: 'Organize our weekend', interpreted_intent: 'organize_weekend',
  conversation_id: null, clarifications: [{ question: 'Which weekend?', reason: 'Two weekends fit.', asked_at: '2026-09-01T00:00:00.000Z', answer: null, answered_at: null }],
};

const state: { run: Record<string, unknown> | null; deleted: boolean } = { run: RUN, deleted: true };
let db: ReturnType<typeof makeDb>;

/** Family-scoped like the real tables: a read whose family filter does not match the row returns nothing. */
function respond(call: Call): Reply {
  const family = call.filters.family_id;
  if (call.table === 'family_automation_runs') {
    if (call.kind === 'delete') return { data: state.deleted ? [{ id: call.filters.id }] : [], error: null };
    if (call.kind === 'select') return { data: state.run && state.run.family_id === family ? state.run : null, error: null };
    return { data: null, error: null };
  }
  if (call.table === 'ai_requests' && call.kind === 'select') return { data: REQUEST.family_id === family ? REQUEST : null, error: null };
  if (call.table === 'ai_plans') return { data: { id: 'plan-1', family_id: 'fam-1', objective: 'Weekend', reasoning_summary: 'Two free slots.' }, error: null };
  if (call.table === 'ai_plan_steps') return { data: [{ id: 'step-1', family_id: 'fam-1', plan_id: 'plan-1', sequence: 0, status: 'queued' }], error: null };
  if (call.table === 'ai_run_events') return { data: call.kind === 'select' ? [{ id: 'ev-1', run_id: 'run-1', event_type: 'planned', message: 'Planned.' }] : null, error: null };
  if (call.table === 'approval_requests') return { data: [], error: null };
  return { data: null, error: null };
}

vi.mock('@/lib/supabase/server', () => ({ createServer: async () => db, createServiceClient: () => db }));
vi.mock('@/lib/supabase/auth', () => ({ getUserContext: () => getUserContext() }));
vi.mock('@/lib/supabase/bearer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/supabase/bearer')>()),
  getBearerUserContext: async () => ({ ok: false, reason: 'invalid_token' }),
}));
vi.mock('@/lib/server/ensure-family', () => ({ ensureActiveFamily: async () => false }));
// `react.cache` is server-only; the tier module is not under test here.
vi.mock('@/lib/server/feature-tiers', () => ({ getResolvedFeatureTiers: async () => ({ 'ai-requests': 'basic' }) }));
vi.mock('@/lib/server/plan', () => ({ resolveFamilyPlanLevel: async () => 1 }));
vi.mock('@/lib/server/rate-limit', () => ({ rateLimit: () => ({ ok: true }) }));
vi.mock('@/lib/server/rate-limit-db', () => ({ rateLimitDb: async () => ({ ok: true }) }));
vi.mock('@/lib/ai/context/intents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/context/intents')>()),
  classifyIntent: async () => ({ intent: 'other', confidence: 0, entities: {}, source: 'fast_path' }),
}));
vi.mock('@/lib/ai/context/builder', () => ({ buildContext: (...a: unknown[]) => buildContext(...a) }));
vi.mock('@/lib/ai/planner', () => ({ planRequest: (...a: unknown[]) => planRequest(...a) }));
vi.mock('@/lib/ai/runs/continue', () => ({ kickRun: (...a: unknown[]) => kickRun(...a) }));
vi.mock('@/lib/ai/runs/controls', () => ({
  pauseRun: (...a: unknown[]) => pauseRun(...a),
  resumeRun: (...a: unknown[]) => resumeRun(...a),
  cancelRun: (...a: unknown[]) => cancelRun(...a),
  rerunStep: (...a: unknown[]) => rerunStep(...a),
}));

function ctxFor(familyId: string, role = 'parent', memberId = 'member-1') {
  return {
    user: { id: 'user-1', email: 'parent@example.com' },
    memberships: [],
    active: { familyId, role, family: { name: 'Fam', timezone: 'America/Chicago' }, member: { id: memberId } },
  };
}

function get(id: string) {
  return new NextRequest(`http://localhost/api/ai/runs/${id}`, { method: 'GET' });
}
function post(id: string, action: string, body?: unknown) {
  return new NextRequest(`http://localhost/api/ai/runs/${id}/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  db = makeDb(respond);
  state.run = RUN;
  state.deleted = true;
  getUserContext.mockResolvedValue(ctxFor('fam-1'));
  buildContext.mockResolvedValue({ ok: true, data: { header: {}, slices: {}, stats: {}, sensitiveOmitted: [], text: 'ctx' } });
  planRequest.mockResolvedValue({ ok: true, data: { kind: 'plan', planId: 'plan-2', runId: 'run-new', stepCount: 3, riskLevel: 'low', requiresApproval: false, summary: 'Saturday is sorted.' } });
  pauseRun.mockResolvedValue({ ok: true, data: { state: 'paused' } });
  resumeRun.mockResolvedValue({ ok: true, data: { state: 'ready' } });
  cancelRun.mockResolvedValue({ ok: true, data: { state: 'cancelled', cancelledSteps: 2, cancelledApprovals: 1 } });
  rerunStep.mockResolvedValue({ ok: true, data: { rerun: true, state: 'queued', detail: 'Queued again.' } });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });

describe('GET /api/ai/runs/[id]', () => {
  it('401s anonymous callers', async () => {
    getUserContext.mockResolvedValue(null);
    const { GET } = await import('@/app/api/ai/runs/[id]/route');
    expect((await GET(get('run-1'), params('run-1'))).status).toBe(401);
  });

  it('returns the family-scoped detail: run, request, plan, steps, events, approvals', async () => {
    state.run = { ...RUN, plan_id: 'plan-1', state: 'executing' };
    const { GET } = await import('@/app/api/ai/runs/[id]/route');
    const res = await GET(get('run-1'), params('run-1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.run).toMatchObject({ id: 'run-1', state: 'executing' });
    expect(body.plan).toMatchObject({ id: 'plan-1', reasoning_summary: 'Two free slots.' });
    expect(body.request).toMatchObject({ id: 'req-1', request_text: 'Organize our weekend' });
    expect(body.steps).toHaveLength(1);
    expect(body.events).toHaveLength(1);
    expect(body.approvals).toEqual([]);
    for (const call of db.calls.filter((c) => c.kind === 'select')) expect(call.filters.family_id).toBe('fam-1');
  });

  it('404s a run that belongs to another family — never a 403 that confirms it exists', async () => {
    getUserContext.mockResolvedValue(ctxFor('fam-2'));
    const { GET } = await import('@/app/api/ai/runs/[id]/route');
    const res = await GET(get('run-1'), params('run-1'));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Run not found.', code: 'not_found' });
    expect(db.calls.find((c) => c.table === 'family_automation_runs')?.filters).toMatchObject({ id: 'run-1', family_id: 'fam-2' });
  });
});

describe('POST /api/ai/runs/[id]/answer', () => {
  it('records the answer, re-plans the same request and continues the same run', async () => {
    const { POST } = await import('@/app/api/ai/runs/[id]/answer/route');
    const res = await POST(post('run-1', 'answer', { answer: 'This one' }), params('run-1'));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({
      requestId: 'req-1', runId: 'run-1', planId: 'plan-2', outcome: 'plan', summary: 'Saturday is sorted.', redirect: '/dashboard/concierge/runs/run-1',
    });

    // The answer lands on the request's clarifications and the planner sees it.
    const recorded = db.calls.find((c) => c.table === 'ai_requests' && c.kind === 'update' && Array.isArray((c.payload as Record<string, unknown>).clarifications));
    expect(recorded?.payload).toMatchObject({ status: 'planning', clarifications: [{ question: 'Which weekend?', reason: 'Two weekends fit.', asked_at: '2026-09-01T00:00:00.000Z', answer: 'This one', answered_at: expect.any(String) }] });
    expect(planRequest).toHaveBeenCalledTimes(1);
    expect(planRequest.mock.calls[0][1]).toMatchObject({ requestId: 'req-1', requestText: 'Organize our weekend', intent: 'organize_weekend', answers: { 'Which weekend?': 'This one' } });
    expect(buildContext.mock.calls[0][1]).toMatchObject({ intent: 'organize_weekend', requestId: 'req-1' });

    // The planner's fresh run is retired with a guarded delete; the plan attaches to the run the person is on.
    const retired = db.calls.find((c) => c.table === 'family_automation_runs' && c.kind === 'delete');
    expect(retired?.filters).toMatchObject({ id: 'run-new', family_id: 'fam-1', state: 'ready', lease_owner: null });
    const attached = db.calls.find((c) => c.table === 'family_automation_runs' && c.kind === 'update' && (c.payload as Record<string, unknown>).plan_id === 'plan-2');
    expect(attached?.filters).toMatchObject({ id: 'run-1', family_id: 'fam-1' });
    expect(attached?.payload).toMatchObject({ state: 'ready', summary: 'Saturday is sorted.' });

    const events = db.calls.filter((c) => c.table === 'ai_run_events' && c.kind === 'insert').map((c) => (c.payload as Record<string, unknown>).event_type);
    expect(events).toEqual(['clarification_answered', 'planned']);
    expect(kickRun).toHaveBeenCalledTimes(1);
    expect(kickRun.mock.calls[0][0]).toBe('run-1');
  });

  it('hands over to the planner\'s run when the cron already claimed it, so nothing runs twice', async () => {
    state.deleted = false;
    const { POST } = await import('@/app/api/ai/runs/[id]/answer/route');
    const res = await POST(post('run-1', 'answer', { answer: 'This one' }), params('run-1'));
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ runId: 'run-new', redirect: '/dashboard/concierge/runs/run-new' });
    const closed = db.calls.find((c) => c.table === 'family_automation_runs' && c.kind === 'update' && (c.payload as Record<string, unknown>).state === 'completed');
    expect(closed?.filters).toMatchObject({ id: 'run-1' });
    expect(db.calls.some((c) => c.table === 'family_automation_runs' && c.kind === 'update' && (c.payload as Record<string, unknown>).plan_id === 'plan-2')).toBe(false);
    expect(kickRun).toHaveBeenCalledWith('run-new', expect.objectContaining({ budgetMs: expect.any(Number) }));
  });

  it('keeps the run waiting when the planner asks again', async () => {
    planRequest.mockResolvedValue({ ok: true, data: { kind: 'clarification', question: 'Morning or afternoon?', requestId: 'req-1' } });
    const { POST } = await import('@/app/api/ai/runs/[id]/answer/route');
    const res = await POST(post('run-1', 'answer', { answer: 'This one' }), params('run-1'));
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ outcome: 'clarification', runId: 'run-1', question: 'Morning or afternoon?' });
    const reparked = db.calls.find((c) => c.table === 'family_automation_runs' && c.kind === 'update' && (c.payload as Record<string, unknown>).state === 'awaiting_context');
    expect(reparked?.payload).toMatchObject({ summary: 'Morning or afternoon?' });
    expect(kickRun).not.toHaveBeenCalled();
  });

  it('409s a run that is not waiting on an answer', async () => {
    state.run = { ...RUN, state: 'executing' };
    const { POST } = await import('@/app/api/ai/runs/[id]/answer/route');
    const res = await POST(post('run-1', 'answer', { answer: 'This one' }), params('run-1'));
    expect(res.status).toBe(409);
    expect(planRequest).not.toHaveBeenCalled();
  });

  it('403s a member who neither manages the family nor asked, 404s another family, 400s an empty answer', async () => {
    const { POST } = await import('@/app/api/ai/runs/[id]/answer/route');
    getUserContext.mockResolvedValue(ctxFor('fam-1', 'teen', 'member-9'));
    expect((await POST(post('run-1', 'answer', { answer: 'This one' }), params('run-1'))).status).toBe(403);
    getUserContext.mockResolvedValue(ctxFor('fam-2'));
    expect((await POST(post('run-1', 'answer', { answer: 'This one' }), params('run-1'))).status).toBe(404);
    getUserContext.mockResolvedValue(ctxFor('fam-1'));
    expect((await POST(post('run-1', 'answer', { answer: '  ' }), params('run-1'))).status).toBe(400);
    expect(planRequest).not.toHaveBeenCalled();
  });

  it('re-parks the run and keeps the answer when the planner fails', async () => {
    planRequest.mockResolvedValue({ ok: false, error: 'The model is unavailable.', code: 'network', retryable: true });
    const { POST } = await import('@/app/api/ai/runs/[id]/answer/route');
    const res = await POST(post('run-1', 'answer', { answer: 'This one' }), params('run-1'));
    expect(res.status).toBe(503);
    const updates = db.calls.filter((c) => c.table === 'family_automation_runs' && c.kind === 'update').map((c) => (c.payload as Record<string, unknown>).state);
    expect(updates).toEqual(['planning', 'awaiting_context']);
    expect(kickRun).not.toHaveBeenCalled();
  });
});

describe('run controls', () => {
  it('pause and cancel report the new state; resume and rerun kick the continuation', async () => {
    const pause = await import('@/app/api/ai/runs/[id]/pause/route');
    const resume = await import('@/app/api/ai/runs/[id]/resume/route');
    const cancel = await import('@/app/api/ai/runs/[id]/cancel/route');
    const rerun = await import('@/app/api/ai/runs/[id]/rerun/route');

    expect(await (await pause.POST(post('run-1', 'pause'), params('run-1'))).json()).toMatchObject({ action: 'pause', state: 'paused' });
    expect(kickRun).not.toHaveBeenCalled();
    expect(await (await resume.POST(post('run-1', 'resume'), params('run-1'))).json()).toMatchObject({ action: 'resume', state: 'ready' });
    expect(kickRun).toHaveBeenCalledWith('run-1', expect.objectContaining({ budgetMs: expect.any(Number) }));
    expect(await (await cancel.POST(post('run-1', 'cancel'), params('run-1'))).json()).toMatchObject({ action: 'cancel', state: 'cancelled', detail: 'Cancelled — 2 steps will not run, 1 approval withdrawn.' });
    expect((await rerun.POST(post('run-1', 'rerun', {}), params('run-1'))).status).toBe(400);
    expect(await (await rerun.POST(post('run-1', 'rerun', { stepId: 'step-1' }), params('run-1'))).json()).toMatchObject({ action: 'rerun', state: 'queued' });
    expect(rerunStep.mock.calls[0][1]).toBe('run-1');
    expect(rerunStep.mock.calls[0][2]).toBe('step-1');
    expect(kickRun).toHaveBeenCalledTimes(2);
    // Every control acted under the caller's family scope.
    for (const fn of [pauseRun, resumeRun, cancelRun, rerunStep]) expect(fn.mock.calls[0][0]).toMatchObject({ familyId: 'fam-1', actorKind: 'member' });
  });

  it('maps the controls\' service codes to statuses', async () => {
    pauseRun.mockResolvedValue({ ok: false, error: 'Only a parent or adult in the family can do that.', code: 'denied' });
    cancelRun.mockResolvedValue({ ok: false, error: 'That run could not be found.', code: 'not_found' });
    resumeRun.mockResolvedValue({ ok: false, error: 'That run cannot be resumed right now.', code: 'invalid_input' });
    const pause = await import('@/app/api/ai/runs/[id]/pause/route');
    const cancel = await import('@/app/api/ai/runs/[id]/cancel/route');
    const resume = await import('@/app/api/ai/runs/[id]/resume/route');
    expect((await pause.POST(post('run-1', 'pause'), params('run-1'))).status).toBe(403);
    expect((await cancel.POST(post('run-1', 'cancel'), params('run-1'))).status).toBe(404);
    expect((await resume.POST(post('run-1', 'resume'), params('run-1'))).status).toBe(409);
    expect(kickRun).not.toHaveBeenCalled();
  });
});
