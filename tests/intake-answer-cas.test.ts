// A clarification answer is submitted twice — two tabs, a retried POST, a
// double tap — and both arrive while the run reads `awaiting_context`. Before
// the compare-and-set in `answerClarification`, both would record an answer,
// both would re-plan the same request, and the second would repoint a run the
// first had already handed to the executor. This drives the real intake
// against the in-memory PostgREST stand-in (real filters, real rows, the same
// update the CAS issues against Postgres), with only the model behind a fake
// planner, and proves: one answer wins, the other is refused without writing,
// and a plan for a run that was stopped while the model was thinking is
// never attached.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

const FAMILY = '00000000-0000-4000-8000-00000000fa01';
const USER = '00000000-0000-4000-8000-0000000000a1';
const PARENT = '00000000-0000-4000-8000-00000000me01';
const CHILD_USER = '00000000-0000-4000-8000-0000000000a2';
const CHILD = '00000000-0000-4000-8000-00000000me02';
const RUN = '00000000-0000-4000-8000-00000000ru01';
const REQUEST = '00000000-0000-4000-8000-00000000rq01';
const PLAN = '00000000-0000-4000-8000-00000000pl01';

const holder = vi.hoisted(() => ({ client: null as unknown }));
const planRequest = vi.fn();
const buildContext = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => holder.client,
  createServer: async () => holder.client,
}));
vi.mock('@/lib/ai/planner', () => ({ planRequest: (...a: unknown[]) => planRequest(...a) }));
vi.mock('@/lib/ai/context/builder', () => ({ buildContext: (...a: unknown[]) => buildContext(...a) }));

let db: InMemorySupabase;
let client: SupabaseClient<Database>;

function scope(): ServiceScope {
  return { db: client, familyId: FAMILY, userId: USER, memberId: PARENT, role: 'parent', actorKind: 'member', tz: 'America/New_York' };
}

/** What the planner does for a plan outcome, minus the model: a plan row, a fresh ready run, and the outcome pointing at both. */
async function plannerPlans(plannerScope: ServiceScope = scope()): Promise<{ ok: true; data: Record<string, unknown> }> {
  await client.from('ai_plans').insert({ id: PLAN, family_id: FAMILY, request_id: REQUEST, version: 2, status: 'approved' });
  const { data } = await client.from('family_automation_runs')
    .insert({ family_id: FAMILY, request_id: REQUEST, plan_id: PLAN, state: 'ready', status: 'approved', run_type: 'concierge', requested_by_member_id: plannerScope.memberId, lease_owner: null, attempt: 0, max_attempts: 5 })
    .select('id').single();
  return { ok: true, data: { kind: 'plan', planId: PLAN, runId: (data as { id: string }).id, stepCount: 2, riskLevel: 'low', requiresApproval: false, summary: 'Saturday is sorted.' } };
}

beforeAll(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterAll(() => { vi.restoreAllMocks(); });

beforeEach(() => {
  db = createInMemorySupabase({ userId: USER });
  client = db as unknown as SupabaseClient<Database>;
  holder.client = client;
  db.seed('families', [{ id: FAMILY, timezone: 'America/New_York' }]);
  db.seed('family_members', [
    { id: PARENT, family_id: FAMILY, user_id: USER, role: 'parent', is_active: true },
    { id: CHILD, family_id: FAMILY, user_id: CHILD_USER, role: 'child', is_active: true },
  ]);
  db.seed('ai_requests', [{
    id: REQUEST, family_id: FAMILY, requested_by: USER, requested_by_member_id: PARENT, kind: 'concierge', request_text: 'Organize our weekend',
    interpreted_intent: 'organize_weekend', status: 'awaiting_context', conversation_id: null, error: null,
    clarifications: [{ question: 'Which weekend?', reason: 'Two fit.', asked_at: '2026-09-01T00:00:00.000Z', answer: null, answered_at: null }],
  }]);
  db.seed('family_automation_runs', [{
    id: RUN, family_id: FAMILY, request_id: REQUEST, plan_id: null, requested_by_member_id: PARENT, run_type: 'concierge',
    state: 'awaiting_context', status: 'pending', summary: 'Which weekend?', lease_owner: null, lease_expires_at: null, attempt: 0, max_attempts: 5, error: null,
  }]);
  planRequest.mockReset();
  buildContext.mockReset();
  buildContext.mockResolvedValue({ ok: true, data: { header: { tz: 'America/New_York' }, slices: {}, stats: {}, sensitiveOmitted: [], text: 'ctx' } });
  planRequest.mockImplementation(plannerPlans);
});

const run = () => db.table('family_automation_runs').find((r) => r.id === RUN) as Row;
const request = () => db.table('ai_requests').find((r) => r.id === REQUEST) as Row;

function expectNoAnswerWork(kick: () => void): void {
  expect(buildContext).not.toHaveBeenCalled();
  expect(planRequest).not.toHaveBeenCalled();
  expect(kick).not.toHaveBeenCalled();
  expect(run()).toMatchObject({ state: 'awaiting_context', plan_id: null, lease_owner: null });
  expect(request()).toMatchObject({ status: 'awaiting_context' });
  expect((request().clarifications as Row[])[0].answer).toBeNull();
  expect(db.table('ai_run_events')).toHaveLength(0);
  expect(db.table('ai_request_context')).toHaveLength(0);
  expect(db.table('ai_plans')).toHaveLength(0);
  // Only the initial run read occurred: no claim or compensating state write.
  expect(db.log.filter((entry) => entry.table === 'family_automation_runs')).toHaveLength(1);
}

describe('answerClarification requester boundary', () => {
  it('denies a manager answering a child request before gathering context or claiming the run', async () => {
    const { answerClarification } = await import('@/lib/ai/runs/intake');
    Object.assign(run(), { requested_by_member_id: CHILD });
    Object.assign(request(), { requested_by: CHILD_USER, requested_by_member_id: CHILD });
    const kick = vi.fn();

    const result = await answerClarification(scope(), RUN, 'Use my private financial details', { db: client, kick });

    expect(result).toEqual({
      ok: false, code: 'denied', error: 'Only the person who made this request can answer that clarification.',
    });
    expectNoAnswerWork(kick);
    expect(db.log).toEqual([{ table: 'family_automation_runs' }]);
  });

  it.each(['requested_by', 'requested_by_member_id'] as const)('rejects a request whose %s does not match the run requester', async (field) => {
    const { answerClarification } = await import('@/lib/ai/runs/intake');
    request()[field] = field === 'requested_by' ? CHILD_USER : CHILD;
    const kick = vi.fn();

    const result = await answerClarification(scope(), RUN, 'This one', { db: client, kick });

    expect(result).toMatchObject({ ok: false, code: 'denied' });
    expectNoAnswerWork(kick);
  });

  it.each(['missing', 'inactive', 'different user', 'different family'] as const)('rejects %s current membership before any answer work', async (membership) => {
    const { answerClarification } = await import('@/lib/ai/runs/intake');
    const member = db.table('family_members').find((row) => row.id === PARENT) as Row;
    if (membership === 'missing') db.replace('family_members', db.table('family_members').filter((row) => row.id !== PARENT));
    if (membership === 'inactive') member.is_active = false;
    if (membership === 'different user') member.user_id = CHILD_USER;
    if (membership === 'different family') member.family_id = '00000000-0000-4000-8000-00000000fa02';
    const kick = vi.fn();

    const result = await answerClarification(scope(), RUN, 'This one', { db: client, kick });

    expect(result).toMatchObject({ ok: false, code: 'denied' });
    expectNoAnswerWork(kick);
  });

  it('continues a child requester with their current role instead of a cached manager role', async () => {
    const { answerClarification } = await import('@/lib/ai/runs/intake');
    Object.assign(run(), { requested_by_member_id: CHILD });
    Object.assign(request(), { requested_by: CHILD_USER, requested_by_member_id: CHILD });
    const caller: ServiceScope = { ...scope(), userId: CHILD_USER, memberId: CHILD, role: 'parent' };
    const kick = vi.fn();

    const result = await answerClarification(caller, RUN, 'This weekend', { db: client, kick });

    expect(result).toMatchObject({ ok: true, data: { requestId: REQUEST, runId: RUN, planId: PLAN, outcome: 'plan' } });
    const expectedScope = {
      familyId: FAMILY, userId: CHILD_USER, memberId: CHILD, role: 'child', actorKind: 'member',
      tz: 'America/New_York', requestId: REQUEST, runId: RUN,
    };
    expect(buildContext).toHaveBeenCalledWith(expect.objectContaining(expectedScope), { intent: 'organize_weekend', requestId: REQUEST });
    expect(planRequest.mock.calls[0][0]).toMatchObject(expectedScope);
    expect(run()).toMatchObject({ state: 'ready', plan_id: PLAN, requested_by_member_id: CHILD });
    expect(request()).toMatchObject({ requested_by: CHILD_USER, requested_by_member_id: CHILD });
    expect(kick).toHaveBeenCalledTimes(1);
    expect(kick).toHaveBeenCalledWith(RUN, expect.any(Object));
  });
});

describe('answerClarification under a double submission', () => {
  it('lets exactly one answer claim the run; the other is refused before it writes anything', async () => {
    const { answerClarification } = await import('@/lib/ai/runs/intake');
    const kicks: string[] = [];
    const answer = () => answerClarification(scope(), RUN, 'This one', { db: client, kick: (id) => { kicks.push(id); } });

    // Both calls pass the "is it awaiting_context?" read before either updates.
    const [first, second] = await Promise.all([answer(), answer()]);
    const outcomes = [first, second];
    const won = outcomes.filter((r) => r.ok);
    const lost = outcomes.filter((r) => !r.ok);
    expect(won).toHaveLength(1);
    expect(lost).toEqual([{ ok: false, error: 'That answer is already being handled.', code: 'invalid_input' }]);
    if (!won[0].ok) return;
    expect(won[0].data).toMatchObject({ requestId: REQUEST, runId: RUN, planId: PLAN, outcome: 'plan', redirect: `/dashboard/concierge/runs/${RUN}` });

    // One re-plan, one kick, one answer on the request, the plan attached to the run the person is on.
    expect(planRequest).toHaveBeenCalledTimes(1);
    expect(planRequest.mock.calls[0][1]).toMatchObject({ requestId: REQUEST, answers: { 'Which weekend?': 'This one' } });
    expect(kicks).toEqual([RUN]);
    expect(run()).toMatchObject({ state: 'ready', plan_id: PLAN, lease_owner: null });
    const answered = (request().clarifications as Row[]).filter((c) => c.answer);
    expect(answered).toHaveLength(1);
    expect(request()).toMatchObject({ status: 'planning' });
    // The planner's fresh run was retired; only the person's run remains for this request.
    expect(db.table('family_automation_runs').filter((r) => r.request_id === REQUEST)).toHaveLength(1);
    const events = db.table('ai_run_events').filter((e) => e.run_id === RUN).map((e) => e.event_type);
    expect(events).toEqual(['clarification_answered', 'planned']);
  });

  it('refuses an answer for a run that is no longer waiting, without touching the request', async () => {
    const { answerClarification } = await import('@/lib/ai/runs/intake');
    Object.assign(run(), { state: 'executing', status: 'approved' });
    const result = await answerClarification(scope(), RUN, 'This one', { db: client, kick: () => {} });
    expect(result).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(planRequest).not.toHaveBeenCalled();
    expect((request().clarifications as Row[])[0].answer).toBeNull();
    expect(db.table('ai_run_events')).toHaveLength(0);
  });

  it('does not attach the plan, and kicks nothing, when the run was cancelled while the model was thinking', async () => {
    const { answerClarification } = await import('@/lib/ai/runs/intake');
    planRequest.mockImplementation(async () => {
      // A cancel from another tab lands mid-plan.
      Object.assign(run(), { state: 'cancelled', status: 'cancelled', cancel_requested_at: new Date().toISOString() });
      return plannerPlans();
    });
    const kicks: string[] = [];
    const result = await answerClarification(scope(), RUN, 'This one', { db: client, kick: (id) => { kicks.push(id); } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toMatchObject({ runId: RUN, planId: PLAN, outcome: 'plan' });
    // The compare-and-set from `planning` matched nothing: the cancelled run keeps no plan and never runs.
    expect(run()).toMatchObject({ state: 'cancelled', plan_id: null });
    expect(kicks).toEqual([]);
    expect(db.table('family_automation_runs').filter((r) => r.request_id === REQUEST)).toHaveLength(1);
    expect(db.table('ai_run_events').filter((e) => e.run_id === RUN).map((e) => e.event_type)).toEqual(['clarification_answered']);
  });

  it('re-parks the run and keeps the answer when the planner fails, so the next answer can claim it again', async () => {
    const { answerClarification } = await import('@/lib/ai/runs/intake');
    planRequest.mockResolvedValueOnce({ ok: false, error: 'The model is unavailable.', code: 'network', retryable: true });
    const first = await answerClarification(scope(), RUN, 'This one', { db: client, kick: () => {} });
    expect(first).toMatchObject({ ok: false, code: 'network' });
    expect(run()).toMatchObject({ state: 'awaiting_context', plan_id: null });
    expect((request().clarifications as Row[])[0].answer).toBe('This one');

    const kicks: string[] = [];
    const second = await answerClarification(scope(), RUN, 'This one, definitely', { db: client, kick: (id) => { kicks.push(id); } });
    expect(second.ok).toBe(true);
    expect(planRequest).toHaveBeenCalledTimes(2);
    expect(kicks).toEqual([RUN]);
    expect(run()).toMatchObject({ state: 'ready', plan_id: PLAN });
  });
});

describe('updateRunWhereState', () => {
  it('patches only a row in the expected state and reports whether it did', async () => {
    const { updateRunWhereState } = await import('@/lib/ai/runs/store');
    const miss = await updateRunWhereState(scope(), RUN, 'planning', { state: 'ready', status: 'approved' }, { db: client });
    expect(miss).toEqual({ ok: true, data: false });
    expect(run()).toMatchObject({ state: 'awaiting_context' });

    const hit = await updateRunWhereState(scope(), RUN, 'awaiting_context', { state: 'planning', status: 'approved' }, { db: client });
    expect(hit).toEqual({ ok: true, data: true });
    expect(run()).toMatchObject({ state: 'planning', status: 'approved' });

    // Another family's scope never matches, whatever the state.
    const foreign = await updateRunWhereState({ ...scope(), familyId: '00000000-0000-4000-8000-00000000fa02' }, RUN, 'planning', { state: 'ready' }, { db: client });
    expect(foreign).toEqual({ ok: true, data: false });
    expect(run()).toMatchObject({ state: 'planning' });
  });
});
