// The server actions behind the Ask bar and the run page are the routes'
// twins, and a twin must carry the routes' gates: asking and answering are
// model calls, so they draw on the same durable per-user rate limit as
// POST /api/ai/requests; answering, resuming and re-running start execution
// with the run's authority, so they pass the feature/plan/allowance check
// first; pause and cancel stay open. And the refresh action hands the browser
// the same `RunView` the page renders — never the raw rows.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requireUserContext = vi.fn();
const rateLimit = vi.fn();
const rateLimitDb = vi.fn();
const getResolvedFeatureTiers = vi.fn();
const resolveFamilyPlanLevel = vi.fn();
const isAIConfigured = vi.fn();
const submitRequest = vi.fn();
const answerClarification = vi.fn();
const applyRunControl = vi.fn();
const loadRunDetail = vi.fn();

vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: () => requireUserContext() }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => ({}), createServiceClient: () => ({}) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/server/rate-limit', () => ({ rateLimit: (...a: unknown[]) => rateLimit(...a) }));
vi.mock('@/lib/server/rate-limit-db', () => ({ rateLimitDb: (...a: unknown[]) => rateLimitDb(...a) }));
vi.mock('@/lib/server/feature-tiers', () => ({ getResolvedFeatureTiers: (...a: unknown[]) => getResolvedFeatureTiers(...a) }));
vi.mock('@/lib/server/plan', () => ({ resolveFamilyPlanLevel: (...a: unknown[]) => resolveFamilyPlanLevel(...a) }));
vi.mock('@/lib/ai/provider', () => ({ isAIConfigured: () => isAIConfigured() }));
vi.mock('@/lib/ai/runs/intake', () => ({
  submitRequest: (...a: unknown[]) => submitRequest(...a),
  answerClarification: (...a: unknown[]) => answerClarification(...a),
  applyRunControl: (...a: unknown[]) => applyRunControl(...a),
}));
vi.mock('@/lib/ai/runs/detail', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/runs/detail')>()),
  loadRunDetail: (...a: unknown[]) => loadRunDetail(...a),
}));

const ctx = {
  user: { id: 'user-1', email: 'parent@example.com' },
  memberships: [],
  active: { familyId: 'fam-1', role: 'parent', family: { name: 'Fam', timezone: 'America/Chicago' }, member: { id: 'member-1' } },
};

beforeEach(() => {
  requireUserContext.mockResolvedValue(ctx);
  rateLimit.mockReturnValue({ ok: true });
  rateLimitDb.mockResolvedValue({ ok: true });
  getResolvedFeatureTiers.mockResolvedValue({ 'ai-requests': 'basic' });
  resolveFamilyPlanLevel.mockResolvedValue(1);
  isAIConfigured.mockResolvedValue(true);
  submitRequest.mockResolvedValue({ ok: true, data: { requestId: 'req-1', runId: 'run-1', planId: 'plan-1', outcome: 'plan', summary: 'Planned.', redirect: '/dashboard/concierge/runs/run-1' } });
  answerClarification.mockResolvedValue({ ok: true, data: { requestId: 'req-1', runId: 'run-1', planId: 'plan-2', outcome: 'plan', summary: 'Sorted.', redirect: '/dashboard/concierge/runs/run-1' } });
  applyRunControl.mockImplementation(async (_scope: unknown, _runId: string, action: string) => ({ ok: true, data: { action, state: 'ready', detail: 'ok' } }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });

describe('askBubalyAction', () => {
  it('draws on the same durable per-user rate limit as the request route, before anything is filed', async () => {
    rateLimitDb.mockResolvedValue({ ok: false, retryAfter: 17 });
    const { askBubalyAction } = await import('@/app/(app)/dashboard/concierge/run-actions');
    const result = await askBubalyAction({ text: 'Plan our week' });
    expect(result).toEqual({ ok: false, error: 'Too many requests. Please try again shortly.', code: 'rate_limited' });
    expect(rateLimitDb.mock.calls[0][1]).toBe('ai-requests:user-1');
    expect(rateLimitDb.mock.calls[0][2]).toEqual({ limit: 20, windowMs: 60_000 });
    expect(submitRequest).not.toHaveBeenCalled();
  });

  it('passes a client request id through to the intake and refuses one it cannot store', async () => {
    const { askBubalyAction } = await import('@/app/(app)/dashboard/concierge/run-actions');
    const ok = await askBubalyAction({ text: 'Plan our week', clientRequestId: 'form-4f2a9c1e-0001' });
    expect(ok.ok).toBe(true);
    expect(submitRequest.mock.calls[0][1]).toMatchObject({ text: 'Plan our week', clientRequestId: 'form-4f2a9c1e-0001' });
    expect(submitRequest.mock.calls[0][0]).toMatchObject({ familyId: 'fam-1', actorKind: 'member' });

    const bad = await askBubalyAction({ text: 'Plan our week', clientRequestId: 'nope' });
    expect(bad).toMatchObject({ ok: false, code: 'client_request_id_invalid' });
    expect(submitRequest).toHaveBeenCalledTimes(1);
  });
});

describe('answerRunAction', () => {
  it('is rate-limited and gated before the planner runs', async () => {
    const { answerRunAction } = await import('@/app/(app)/dashboard/concierge/run-actions');
    rateLimitDb.mockResolvedValue({ ok: false, retryAfter: 5 });
    expect(await answerRunAction('run-1', 'This one')).toMatchObject({ ok: false, code: 'rate_limited' });
    expect(rateLimitDb.mock.calls[0][1]).toBe('ai-requests:user-1');

    rateLimitDb.mockResolvedValue({ ok: true });
    getResolvedFeatureTiers.mockResolvedValue({ 'ai-requests': 'off' });
    expect(await answerRunAction('run-1', 'This one')).toEqual({ ok: false, error: 'Ask Bubaly is not available for your family.', code: 'feature_off' });

    getResolvedFeatureTiers.mockResolvedValue({ 'ai-requests': 'plus' });
    resolveFamilyPlanLevel.mockResolvedValue(1);
    expect(await answerRunAction('run-1', 'This one')).toMatchObject({ ok: false, code: 'plan_required' });
    expect(answerClarification).not.toHaveBeenCalled();

    getResolvedFeatureTiers.mockResolvedValue({ 'ai-requests': 'basic' });
    const ok = await answerRunAction('run-1', 'This one');
    expect(ok.ok).toBe(true);
    expect(answerClarification).toHaveBeenCalledTimes(1);
    expect(answerClarification.mock.calls[0][1]).toBe('run-1');
    expect(answerClarification.mock.calls[0][2]).toBe('This one');
  });
});

describe('controlRunAction', () => {
  it('needs the concierge for resume and rerun, which start execution, but never for pause and cancel', async () => {
    const { controlRunAction } = await import('@/app/(app)/dashboard/concierge/run-actions');
    getResolvedFeatureTiers.mockResolvedValue({ 'ai-requests': 'off' });
    expect(await controlRunAction('run-1', 'resume')).toEqual({ ok: false, error: 'Ask Bubaly is not available for your family.', code: 'feature_off' });
    expect(await controlRunAction('run-1', 'rerun', { stepId: 'step-1' })).toMatchObject({ ok: false, code: 'feature_off' });
    expect(applyRunControl).not.toHaveBeenCalled();

    expect(await controlRunAction('run-1', 'pause')).toMatchObject({ ok: true, data: { action: 'pause' } });
    expect(await controlRunAction('run-1', 'cancel')).toMatchObject({ ok: true, data: { action: 'cancel' } });
    expect(applyRunControl.mock.calls.map((c) => c[2])).toEqual(['pause', 'cancel']);

    getResolvedFeatureTiers.mockResolvedValue({ 'ai-requests': 'plus' });
    resolveFamilyPlanLevel.mockResolvedValue(2);
    expect(await controlRunAction('run-1', 'resume')).toMatchObject({ ok: true, data: { action: 'resume' } });
    expect(applyRunControl.mock.calls.at(-1)?.[2]).toBe('resume');
  });
});

describe('loadRunAction', () => {
  it('answers the run view the page renders — never the rows', async () => {
    loadRunDetail.mockResolvedValue({ ok: true, data: {
      run: { id: 'run-1', family_id: 'fam-1', plan_id: 'plan-1', request_id: 'req-1', state: 'executing', status: 'approved', summary: 'Weekend', error: null, created_at: '2026-09-05T10:00:00Z', completed_at: null, lease_owner: 'worker-7', result: { raw: 'output' }, metadata: {}, progress: {} },
      request: { id: 'req-1', request_text: 'Organize our weekend', clarifications: [{ question: 'Which weekend?', answer: null }], prompt_tokens: 1234, model: 'gpt-x' },
      plan: { id: 'plan-1', objective: 'Weekend', reasoning_summary: 'Two free slots.', risk_level: 'low' },
      steps: [{ id: 'step-1', sequence: 0, step_type: 'retrieve', description: 'Look at the calendar', status: 'completed', error: null, dependency_ids: [], input_json: { prompt: 'model prompt text' }, result_json: { rows: 3 } }],
      events: [{ id: 'ev-1', event_type: 'step_completed', message: 'Looked.', created_at: '2026-09-05T10:00:01Z', step_id: 'step-1', actor_kind: 'ai', payload: { output: 'raw tool output' } }],
      approvals: [],
    } });
    const { loadRunAction } = await import('@/app/(app)/dashboard/concierge/run-actions');
    const result = await loadRunAction('run-1');
    expect(result.ok).toBe(true);
    if (!result.ok || !result.data) return;
    expect(loadRunDetail.mock.calls[0].slice(1)).toEqual(['fam-1', 'run-1', { viewerRole: 'parent' }]);
    expect(result.data).toMatchObject({ id: 'run-1', familyId: 'fam-1', state: 'executing', objective: 'Weekend', reasoningSummary: 'Two free slots.', requestText: 'Organize our weekend' });
    expect(result.data.steps).toEqual([{ id: 'step-1', sequence: 0, description: 'Look at the calendar', status: 'completed', error: null }]);
    expect(result.data.events).toEqual([{ id: 'ev-1', type: 'step_completed', message: 'Looked.', at: '2026-09-05T10:00:01Z', stepId: 'step-1', actor: 'ai', metrics: null }]);
    for (const key of ['run', 'request', 'plan']) expect(result.data).not.toHaveProperty(key);
    const json = JSON.stringify(result.data);
    for (const leak of ['worker-7', 'lease', 'raw', 'prompt', 'gpt-x', '1234', 'input_json', 'result_json', 'payload', 'clarifications']) expect(json, leak).not.toContain(leak);

    loadRunDetail.mockResolvedValue({ ok: true, data: null });
    expect(await loadRunAction('run-9')).toEqual({ ok: true, data: null });
  });
});
