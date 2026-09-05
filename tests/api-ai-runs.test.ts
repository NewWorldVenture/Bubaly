// /api/ai/runs/[id] and its controls (map P2-03).
//
// Pinned here: the detail read is family-scoped, a run from another family
// is a 404 (never a 403 that confirms the id), and the body is the page's
// view — never the rows; `answer` claims the run by compare-and-set (a second
// answer for the same run is refused), records the reply on the request,
// re-plans the SAME request, attaches the new plan to the SAME run only while
// it is still the one it claimed — retiring the planner's fresh run with a
// guarded delete — and kicks the continuation; when the cron already claimed
// the planner's run the person is sent there instead and nothing runs twice;
// answer, resume and rerun sit behind the concierge feature/plan gate while
// pause and cancel stay open; the controls map service codes to statuses and
// resume kicks the continuation.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const getUserContext = vi.fn();
const getResolvedFeatureTiers = vi.fn();
const resolveFamilyPlanLevel = vi.fn();
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
  requested_by: 'user-2', requested_by_member_id: 'member-2',
  conversation_id: null, clarifications: [{ question: 'Which weekend?', reason: 'Two weekends fit.', asked_at: '2026-09-01T00:00:00.000Z', answer: null, answered_at: null }],
  model: 'gpt-x', prompt_tokens: 1234, completion_tokens: 56,
};
const FAMILY = { id: 'fam-1', timezone: 'America/Chicago' };
const MEMBERS = [
  { id: 'member-1', family_id: 'fam-1', user_id: 'user-1', role: 'parent', is_active: true },
  { id: 'member-2', family_id: 'fam-1', user_id: 'user-2', role: 'child', is_active: true },
];

const state: { run: Record<string, unknown> | null; deleted: boolean; casMiss: boolean } = { run: { ...RUN }, deleted: true, casMiss: false };
let db: ReturnType<typeof makeDb>;

/** Family-scoped like the real tables: a read whose family filter does not match the row returns nothing. */
function respond(call: Call): Reply {
  const family = call.filters.family_id;
  if (call.table === 'families' && call.kind === 'select') {
    return { data: call.filters.id === FAMILY.id ? FAMILY : null, error: null };
  }
  if (call.table === 'family_members' && call.kind === 'select') {
    return { data: MEMBERS.find((member) => member.id === call.filters.id && member.family_id === family) ?? null, error: null };
  }
  if (call.table === 'family_automation_runs') {
    if (call.kind === 'delete') return { data: state.deleted ? [{ id: call.filters.id }] : [], error: null };
    if (call.kind === 'select') return { data: state.run && state.run.family_id === family ? state.run : null, error: null };
    if (call.kind === 'update') {
      // Like Postgres: the patch lands only on a row every filter matches —
      // family, id and, for a compare-and-set, the expected state — and the
      // reply lists what matched. `casMiss` simulates the race the CAS exists
      // for: another writer moved the row between the read and the update.
      const row = state.run;
      const expected = call.filters.state;
      const matches = !!row && row.family_id === family && row.id === call.filters.id && (expected === undefined || (row.state === expected && !state.casMiss));
      if (matches) Object.assign(row as Record<string, unknown>, call.payload as Record<string, unknown>);
      return { data: matches ? [{ id: call.filters.id }] : [], error: null };
    }
    return { data: null, error: null };
  }
  if (call.table === 'ai_requests' && call.kind === 'select') return { data: REQUEST.family_id === family ? REQUEST : null, error: null };
  if (call.table === 'ai_plans') return { data: { id: 'plan-1', family_id: 'fam-1', objective: 'Weekend', reasoning_summary: 'Two free slots.', risk_level: 'low' }, error: null };
  if (call.table === 'ai_plan_steps') {
    return { data: [{ id: 'step-1', family_id: 'fam-1', plan_id: 'plan-1', sequence: 0, step_type: 'retrieve', description: null, status: 'queued', error: null, dependency_ids: [], input_json: { prompt: 'model prompt text' }, result_json: { raw: 'tool output' } }], error: null };
  }
  if (call.table === 'ai_run_events') return { data: call.kind === 'select' ? [{ id: 'ev-1', run_id: 'run-1', event_type: 'planned', message: 'Planned.', step_id: null, actor_kind: 'ai', created_at: '2026-09-01T00:00:00.000Z', payload: { prompt: 'the whole prompt' } }] : null, error: null };
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
vi.mock('@/lib/server/feature-tiers', () => ({ getResolvedFeatureTiers: (...a: unknown[]) => getResolvedFeatureTiers(...a) }));
vi.mock('@/lib/server/plan', () => ({ resolveFamilyPlanLevel: (...a: unknown[]) => resolveFamilyPlanLevel(...a) }));
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

function ctxFor(familyId: string, role = 'parent', memberId = 'member-1', userId = 'user-1') {
  return {
    user: { id: userId, email: `${userId}@example.com` },
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
  state.run = { ...RUN };
  state.deleted = true;
  state.casMiss = false;
  getUserContext.mockResolvedValue(ctxFor('fam-1'));
  getResolvedFeatureTiers.mockResolvedValue({ 'ai-requests': 'basic' });
  resolveFamilyPlanLevel.mockResolvedValue(1);
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

  it('returns the family-scoped run VIEW — the page\'s boundary — never the rows', async () => {
    state.run = { ...RUN, plan_id: 'plan-1', state: 'executing', lease_owner: 'worker-7', lease_expires_at: '2026-09-01T00:02:00.000Z', result: { raw: 'output' }, metadata: { trace: 'id' }, progress: { internal: 1 } };
    const { GET } = await import('@/app/api/ai/runs/[id]/route');
    const res = await GET(get('run-1'), params('run-1'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      id: 'run-1', familyId: 'fam-1', state: 'executing', planId: 'plan-1', requestId: 'req-1',
      objective: 'Weekend', reasoningSummary: 'Two free slots.', requestText: 'Organize our weekend', riskLevel: 'low',
      progress: { done: 0, total: 1 }, question: null, answered: [], approvals: [],
    });
    expect(body.steps).toEqual([{ id: 'step-1', sequence: 0, description: 'A step Bubaly planned', status: 'queued', error: null }]);
    expect(body.events).toEqual([{ id: 'ev-1', type: 'planned', message: 'Planned.', at: '2026-09-01T00:00:00.000Z', stepId: null, actor: 'ai', metrics: null }]);
    // No raw row, and none of the columns the page deliberately strips.
    for (const key of ['run', 'request', 'plan']) expect(body).not.toHaveProperty(key);
    const json = JSON.stringify(body);
    for (const leak of ['worker-7', 'lease', 'raw', 'trace', 'internal', 'prompt', 'input_json', 'result_json', 'payload', 'clarifications', 'Which weekend?', 'gpt-x', '1234']) {
      expect(json, leak).not.toContain(leak);
    }
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
  beforeEach(() => {
    // Answer as the original child requester, not the family's manager.
    getUserContext.mockResolvedValue(ctxFor('fam-1', 'child', 'member-2', 'user-2'));
  });

  it('records the answer, re-plans the same request and continues the same run', async () => {
    const { POST } = await import('@/app/api/ai/runs/[id]/answer/route');
    const res = await POST(post('run-1', 'answer', { answer: 'This one' }), params('run-1'));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({
      requestId: 'req-1', runId: 'run-1', planId: 'plan-2', outcome: 'plan', summary: 'Saturday is sorted.', redirect: '/dashboard/concierge/runs/run-1',
    });

    // The run is claimed by compare-and-set from awaiting_context before anything is written…
    const claim = db.calls.find((c) => c.table === 'family_automation_runs' && c.kind === 'update' && c.filters.state === 'awaiting_context');
    expect(claim?.filters).toMatchObject({ id: 'run-1', family_id: 'fam-1', state: 'awaiting_context' });
    expect(claim?.payload).toMatchObject({ state: 'planning' });
    const membership = db.calls.find((c) => c.table === 'family_members' && c.kind === 'select');
    expect(membership?.filters).toMatchObject({ id: 'member-2', family_id: 'fam-1' });
    expect(db.calls.indexOf(membership as Call)).toBeLessThan(db.calls.indexOf(claim as Call));
    expect(db.calls.indexOf(claim as Call)).toBeLessThan(db.calls.findIndex((c) => c.table === 'ai_requests' && c.kind === 'update'));
    // …then the answer lands on the request's clarifications and the planner sees it.
    const recorded = db.calls.find((c) => c.table === 'ai_requests' && c.kind === 'update' && Array.isArray((c.payload as Record<string, unknown>).clarifications));
    expect(recorded?.payload).toMatchObject({ status: 'planning', clarifications: [{ question: 'Which weekend?', reason: 'Two weekends fit.', asked_at: '2026-09-01T00:00:00.000Z', answer: 'This one', answered_at: expect.any(String) }] });
    expect(planRequest).toHaveBeenCalledTimes(1);
    expect(planRequest.mock.calls[0][1]).toMatchObject({ requestId: 'req-1', requestText: 'Organize our weekend', intent: 'organize_weekend', answers: { 'Which weekend?': 'This one' } });
    expect(buildContext.mock.calls[0][1]).toMatchObject({ intent: 'organize_weekend', requestId: 'req-1' });
    const requester = { familyId: 'fam-1', userId: 'user-2', memberId: 'member-2', role: 'child', tz: 'America/Chicago' };
    expect(buildContext.mock.calls[0][0]).toMatchObject(requester);
    expect(planRequest.mock.calls[0][0]).toMatchObject(requester);

    // The planner's fresh run is retired with a guarded delete; the plan attaches to the run the person is on.
    const retired = db.calls.find((c) => c.table === 'family_automation_runs' && c.kind === 'delete');
    expect(retired?.filters).toMatchObject({ id: 'run-new', family_id: 'fam-1', state: 'ready', lease_owner: null });
    const attached = db.calls.find((c) => c.table === 'family_automation_runs' && c.kind === 'update' && (c.payload as Record<string, unknown>).plan_id === 'plan-2');
    // Attached by compare-and-set from the state the answer claimed, so only the run this answer owns is repointed.
    expect(attached?.filters).toMatchObject({ id: 'run-1', family_id: 'fam-1', state: 'planning' });
    expect(attached?.payload).toMatchObject({ state: 'ready', summary: 'Saturday is sorted.' });
    expect(state.run).toMatchObject({ state: 'ready', plan_id: 'plan-2' });

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

  it('refuses a second answer once another has claimed the run, and writes nothing more', async () => {
    // The read says awaiting_context, but the compare-and-set finds the row
    // already moved: a double-submitted answer (two tabs, a retried POST).
    state.casMiss = true;
    const { POST } = await import('@/app/api/ai/runs/[id]/answer/route');
    const res = await POST(post('run-1', 'answer', { answer: 'This one' }), params('run-1'));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'That answer is already being handled.', code: 'invalid_input' });
    expect(planRequest).not.toHaveBeenCalled();
    expect(buildContext).not.toHaveBeenCalled();
    expect(db.calls.some((c) => c.table === 'ai_requests' && c.kind === 'update')).toBe(false);
    expect(db.calls.filter((c) => c.table === 'ai_run_events' && c.kind === 'insert')).toHaveLength(0);
    expect(kickRun).not.toHaveBeenCalled();
  });

  it('leaves the plan unattached and kicks nothing when the run was stopped while the model was thinking', async () => {
    planRequest.mockImplementation(async () => {
      // A cancel from another tab lands mid-plan: the placeholder is no longer in `planning`.
      if (state.run) Object.assign(state.run, { state: 'cancelled' });
      return { ok: true, data: { kind: 'plan', planId: 'plan-2', runId: 'run-new', stepCount: 3, riskLevel: 'low', requiresApproval: false, summary: 'Saturday is sorted.' } };
    });
    const { POST } = await import('@/app/api/ai/runs/[id]/answer/route');
    const res = await POST(post('run-1', 'answer', { answer: 'This one' }), params('run-1'));
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ runId: 'run-1', planId: 'plan-2', redirect: '/dashboard/concierge/runs/run-1' });
    // The planner's run was retired, but the compare-and-set on the placeholder matched nothing: no plan, no `planned` event, no kick.
    expect(db.calls.find((c) => c.table === 'family_automation_runs' && c.kind === 'delete')?.filters).toMatchObject({ id: 'run-new' });
    expect(state.run).toMatchObject({ state: 'cancelled', plan_id: null });
    expect(db.calls.filter((c) => c.table === 'ai_run_events' && c.kind === 'insert').map((c) => (c.payload as Record<string, unknown>).event_type)).toEqual(['clarification_answered']);
    expect(kickRun).not.toHaveBeenCalled();
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

  it('403s a parent answering a child request before context, planning or writes', async () => {
    getUserContext.mockResolvedValue(ctxFor('fam-1'));
    const { POST } = await import('@/app/api/ai/runs/[id]/answer/route');
    const res = await POST(post('run-1', 'answer', { answer: 'This one' }), params('run-1'));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: 'Only the person who made this request can answer that clarification.', code: 'denied',
    });
    expect(buildContext).not.toHaveBeenCalled();
    expect(planRequest).not.toHaveBeenCalled();
    expect(kickRun).not.toHaveBeenCalled();
    expect(db.calls.filter((c) => c.kind !== 'select')).toHaveLength(0);
    expect(state.run).toMatchObject({ requested_by_member_id: 'member-2', state: 'awaiting_context', plan_id: null });
  });

  it('403s a non-requester, 404s another family, 400s an empty answer', async () => {
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

describe('the concierge gate on controls that start execution', () => {
  it('404s answer, resume and rerun when the ai-requests feature is off, and never touches the run', async () => {
    getResolvedFeatureTiers.mockResolvedValue({ 'ai-requests': 'off' });
    const answer = await import('@/app/api/ai/runs/[id]/answer/route');
    const resume = await import('@/app/api/ai/runs/[id]/resume/route');
    const rerun = await import('@/app/api/ai/runs/[id]/rerun/route');
    expect((await answer.POST(post('run-1', 'answer', { answer: 'This one' }), params('run-1'))).status).toBe(404);
    expect((await resume.POST(post('run-1', 'resume'), params('run-1'))).status).toBe(404);
    expect((await rerun.POST(post('run-1', 'rerun', { stepId: 'step-1' }), params('run-1'))).status).toBe(404);
    expect(planRequest).not.toHaveBeenCalled();
    expect(resumeRun).not.toHaveBeenCalled();
    expect(rerunStep).not.toHaveBeenCalled();
    expect(kickRun).not.toHaveBeenCalled();
    expect(db.calls.filter((c) => c.kind !== 'select')).toHaveLength(0);
    expect(state.run).toMatchObject({ state: 'awaiting_context' });
  });

  it('403s them below the plan tier, naming the level needed', async () => {
    getResolvedFeatureTiers.mockResolvedValue({ 'ai-requests': 'plus' });
    resolveFamilyPlanLevel.mockResolvedValue(1);
    const answer = await import('@/app/api/ai/runs/[id]/answer/route');
    const resume = await import('@/app/api/ai/runs/[id]/resume/route');
    const rerun = await import('@/app/api/ai/runs/[id]/rerun/route');
    for (const res of [
      await answer.POST(post('run-1', 'answer', { answer: 'This one' }), params('run-1')),
      await resume.POST(post('run-1', 'resume'), params('run-1')),
      await rerun.POST(post('run-1', 'rerun', { stepId: 'step-1' }), params('run-1')),
    ]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'plan_required', needLevel: 2 });
    }
    expect(planRequest).not.toHaveBeenCalled();
    expect(kickRun).not.toHaveBeenCalled();
  });

  it('leaves pause and cancel open to a family whose concierge is off: stopping Bubaly always works', async () => {
    getResolvedFeatureTiers.mockResolvedValue({ 'ai-requests': 'off' });
    const pause = await import('@/app/api/ai/runs/[id]/pause/route');
    const cancel = await import('@/app/api/ai/runs/[id]/cancel/route');
    expect((await pause.POST(post('run-1', 'pause'), params('run-1'))).status).toBe(200);
    expect((await cancel.POST(post('run-1', 'cancel'), params('run-1'))).status).toBe(200);
    expect(pauseRun).toHaveBeenCalledTimes(1);
    expect(cancelRun).toHaveBeenCalledTimes(1);
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
