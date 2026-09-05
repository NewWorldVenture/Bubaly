// The human levers over a run: pause, resume, cancel, re-run a step, edit a
// step (§17, §29, §45).
//
// Two behaviours here are safety-critical and are the reason this file exists.
// Cancelling must close the approvals the run opened and cancel the steps that
// had not run - a half-cancelled run leaves a pending approval that would later
// resume work the family already stopped. And re-running a step must consult
// the `ai_tool_calls` ledger first: if the step's write actually SUCCEEDED and
// only the response was lost, re-running it would put a second event on the
// calendar, which is precisely the duplication §30 exists to prevent.
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { cancelRun, editStepInput, pauseRun, rerunStep, resumeRun } from '@/lib/ai/runs/controls';

type Call = {
  table: string;
  kind: 'select' | 'insert' | 'update';
  filters: Record<string, unknown>;
  payload?: unknown;
};
type Reply = { data: unknown; error: unknown };

/**
 * A chainable stand-in for the PostgREST builder that records what each call
 * asked for, so a test can assert on the FILTERS as well as the payload - "the
 * queued steps were cancelled" is a statement about a `.in('status', ...)`.
 */
function makeDb(respond: (call: Call) => Reply) {
  const calls: Call[] = [];
  const from = (table: string) => {
    const call: Call = { table, kind: 'select', filters: {} };
    calls.push(call);
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    const filter = (column: string, value: unknown) => { call.filters[column] = value; return builder; };
    Object.assign(builder, {
      select: chain,
      order: chain,
      limit: chain,
      eq: filter,
      is: filter,
      in: (column: string, values: unknown) => filter(`in:${column}`, values),
      insert: (payload: unknown) => { call.kind = 'insert'; call.payload = payload; return builder; },
      update: (payload: unknown) => { call.kind = 'update'; call.payload = payload; return builder; },
      single: () => Promise.resolve(respond(call)),
      maybeSingle: () => Promise.resolve(respond(call)),
      then: (resolve: (value: Reply) => void) => resolve(respond(call)),
    });
    return builder;
  };
  return { db: { from } as unknown as SupabaseClient<Database>, calls };
}

function scopeWith(db: SupabaseClient<Database>, extra?: Partial<ServiceScope>): ServiceScope {
  return {
    db,
    familyId: 'fam-1',
    userId: 'auth-1',
    memberId: 'member-1',
    role: 'parent',
    actorKind: 'member',
    tz: 'America/New_York',
    ...extra,
  };
}

const RUN = {
  id: 'run-1',
  family_id: 'fam-1',
  plan_id: 'plan-1',
  request_id: 'req-1',
  requested_by_member_id: 'member-2',
  state: 'executing',
  status: 'approved',
  attempt: 1,
  max_attempts: 5,
  cancel_requested_at: null,
  paused_at: null,
  lease_owner: 'lease-1',
};

function planStep(id: string, over: Partial<Record<string, unknown>> = {}) {
  return {
    id,
    family_id: 'fam-1',
    plan_id: 'plan-1',
    sequence: 0,
    step_type: 'act',
    tool_name: 'calendar.createEvent',
    description: id,
    input_json: { title: id },
    dependency_ids: [],
    condition: null,
    status: 'queued',
    approval_required: false,
    approval_id: null,
    risk_level: 'low',
    retry_count: 0,
    max_retries: 2,
    result_json: null,
    error: null,
    ...over,
  };
}

/** The default responder: a live run, no steps, no tool calls, every write accepted. */
function responder(over: Partial<{ run: unknown; steps: unknown[]; toolCalls: unknown[]; plans: unknown[] }> = {}) {
  return (call: Call): Reply => {
    if (call.table === 'family_automation_runs' && call.kind === 'select') {
      return { data: 'run' in over ? over.run : RUN, error: null };
    }
    if (call.table === 'ai_plan_steps' && call.kind === 'select') return { data: over.steps ?? [], error: null };
    if (call.table === 'ai_tool_calls' && call.kind === 'select') return { data: over.toolCalls ?? [], error: null };
    if (call.table === 'ai_plans' && call.kind === 'select') return { data: over.plans ?? [], error: null };
    if (call.table === 'ai_plans' && call.kind === 'insert') return { data: { id: 'plan-2' }, error: null };
    if (call.kind === 'update' && call.table === 'approval_requests') return { data: [{ id: 'appr-1' }], error: null };
    if (call.kind === 'update' && call.table === 'ai_plan_steps') return { data: [{ id: 's2' }, { id: 's3' }], error: null };
    return { data: null, error: null };
  };
}

const find = (calls: Call[], table: string, kind: Call['kind']) => calls.filter((c) => c.table === table && c.kind === kind);

describe('cancelRun', () => {
  it('stops the run, cancels its pending approvals and its queued steps', async () => {
    const { db, calls } = makeDb(responder());
    const result = await cancelRun(scopeWith(db), 'run-1', { db });

    expect(result).toMatchObject({ ok: true, data: { state: 'cancelled', cancelledSteps: 2, cancelledApprovals: 1 } });

    const runUpdate = find(calls, 'family_automation_runs', 'update')[0];
    expect(runUpdate.payload).toMatchObject({ state: 'cancelled', status: 'skipped', lease_owner: null });
    // `cancel_requested_at` is what an in-flight slice sees on its next pass.
    expect((runUpdate.payload as Record<string, unknown>).cancel_requested_at).toBeTruthy();

    const approvalUpdate = find(calls, 'approval_requests', 'update')[0];
    expect(approvalUpdate.payload).toMatchObject({ status: 'cancelled' });
    expect(approvalUpdate.filters).toMatchObject({ run_id: 'run-1', status: 'pending', family_id: 'fam-1' });

    const stepUpdate = find(calls, 'ai_plan_steps', 'update')[0];
    expect(stepUpdate.payload).toMatchObject({ status: 'cancelled' });
    // Only steps that had not produced a result: finished work is left alone.
    expect(stepUpdate.filters['in:status']).toEqual(['queued', 'ready', 'awaiting_approval', 'executing', 'planning', 'awaiting_context']);

    expect(find(calls, 'ai_run_events', 'insert')[0].payload).toMatchObject({ event_type: 'cancelled', run_id: 'run-1' });
    expect(find(calls, 'audit_logs', 'insert')[0].payload).toMatchObject({ action: 'ai_run.cancel', family_id: 'fam-1' });
    expect(find(calls, 'ai_requests', 'update')[0].payload).toMatchObject({ status: 'cancelled' });
  });

  it('lets the person who asked for the run stop it, but not an unrelated child', async () => {
    const requester = makeDb(responder());
    expect((await cancelRun(scopeWith(requester.db, { role: 'teen', memberId: 'member-2' }), 'run-1', { db: requester.db })).ok).toBe(true);

    const bystander = makeDb(responder());
    const denied = await cancelRun(scopeWith(bystander.db, { role: 'child', memberId: 'member-9' }), 'run-1', { db: bystander.db });
    expect(denied).toMatchObject({ ok: false, code: 'denied' });
    expect(find(bystander.calls, 'family_automation_runs', 'update')).toHaveLength(0);
  });

  it('is a no-op on a run that already finished', async () => {
    const { db, calls } = makeDb(responder({ run: { ...RUN, state: 'completed' } }));
    const result = await cancelRun(scopeWith(db), 'run-1', { db });
    expect(result).toMatchObject({ ok: true, data: { state: 'completed', cancelledSteps: 0 } });
    expect(find(calls, 'family_automation_runs', 'update')).toHaveLength(0);
  });

  it('reports a missing run rather than pretending it cancelled something', async () => {
    const { db } = makeDb(responder({ run: null }));
    expect(await cancelRun(scopeWith(db), 'run-1', { db })).toMatchObject({ ok: false, code: 'not_found' });
  });
});

describe('pauseRun and resumeRun', () => {
  it('pauses a running run and puts a paused one back in the queue', async () => {
    const paused = makeDb(responder());
    const pauseResult = await pauseRun(scopeWith(paused.db), 'run-1', { db: paused.db });
    expect(pauseResult).toMatchObject({ ok: true, data: { state: 'paused' } });
    const pausePayload = find(paused.calls, 'family_automation_runs', 'update')[0].payload as Record<string, unknown>;
    expect(pausePayload.state).toBe('paused');
    expect(pausePayload.paused_at).toBeTruthy();
    // The lease is dropped so the recovery pass has nothing to reclaim.
    expect(pausePayload.lease_owner).toBeNull();

    const resumed = makeDb(responder({ run: { ...RUN, state: 'paused', paused_at: '2026-09-05T10:00:00Z' } }));
    const resumeResult = await resumeRun(scopeWith(resumed.db), 'run-1', { db: resumed.db });
    expect(resumeResult).toMatchObject({ ok: true, data: { state: 'ready' } });
    const resumePayload = find(resumed.calls, 'family_automation_runs', 'update')[0].payload as Record<string, unknown>;
    expect(resumePayload).toMatchObject({ state: 'ready', paused_at: null });
    expect(resumePayload.run_after).toBeTruthy();
  });

  it('refuses to pause a finished run or resume one that is not paused', async () => {
    const finished = makeDb(responder({ run: { ...RUN, state: 'completed' } }));
    expect((await pauseRun(scopeWith(finished.db), 'run-1', { db: finished.db })).ok).toBe(false);

    const running = makeDb(responder());
    expect((await resumeRun(scopeWith(running.db), 'run-1', { db: running.db })).ok).toBe(false);
  });
});

describe('rerunStep', () => {
  it('does NOT re-execute a step whose tool call already succeeded', async () => {
    const { db, calls } = makeDb(responder({
      run: { ...RUN, state: 'partially_completed' },
      steps: [planStep('s1', { status: 'failed', error: 'timeout' })],
      toolCalls: [{ id: 'tc-1', state: 'succeeded', attempt: 1, resource_id: 'evt-1', resource_table: 'calendar_events' }],
    }));

    const result = await rerunStep(scopeWith(db), 'run-1', 's1', { db });

    expect(result).toMatchObject({ ok: true, data: { rerun: false, state: 'completed' } });
    // The step is reconciled to the record that already exists; the run is not
    // re-queued, so nothing can write a second calendar event.
    const stepUpdate = find(calls, 'ai_plan_steps', 'update')[0];
    expect(stepUpdate.payload).toMatchObject({ status: 'completed' });
    expect(find(calls, 'family_automation_runs', 'update')).toHaveLength(0);
    expect(find(calls, 'ai_tool_calls', 'update')).toHaveLength(0);
  });

  it('re-queues a genuinely failed step, bumps the ledger attempt and frees what it blocked', async () => {
    const { db, calls } = makeDb(responder({
      run: { ...RUN, state: 'partially_completed' },
      steps: [
        planStep('s1', { status: 'failed', error: 'timeout' }),
        planStep('s2', { status: 'blocked', dependency_ids: ['s1'] }),
        planStep('s3', { status: 'blocked', dependency_ids: ['s2'] }),
        planStep('s4', { status: 'completed' }),
      ],
      toolCalls: [{ id: 'tc-1', state: 'failed', attempt: 1, resource_id: null, resource_table: null }],
    }));

    const result = await rerunStep(scopeWith(db), 'run-1', 's1', { db });

    expect(result).toMatchObject({ ok: true, data: { rerun: true, state: 'queued' } });
    // The failed ledger row is taken over, so the retry really re-executes.
    expect(find(calls, 'ai_tool_calls', 'update')[0].payload).toMatchObject({ attempt: 2 });

    const stepUpdates = find(calls, 'ai_plan_steps', 'update');
    expect(stepUpdates[0].payload).toMatchObject({ status: 'queued', retry_count: 0, error: null, approval_id: null });
    // Both blocked dependents become runnable again; the completed one is left alone.
    expect(stepUpdates.map((c) => c.filters.id)).toEqual(['s1', 's2', 's3']);

    expect(find(calls, 'family_automation_runs', 'update')[0].payload).toMatchObject({ state: 'ready', completed_at: null });
    expect(find(calls, 'ai_run_events', 'insert')[0].payload).toMatchObject({ event_type: 'step_retried' });
  });

  it('is managers only, even for the person who asked for the run', async () => {
    const { db, calls } = makeDb(responder());
    const denied = await rerunStep(scopeWith(db, { role: 'teen', memberId: 'member-2' }), 'run-1', 's1', { db });
    expect(denied).toMatchObject({ ok: false, code: 'denied' });
    expect(find(calls, 'ai_plan_steps', 'update')).toHaveLength(0);
  });

  it('refuses a step that is not part of the run', async () => {
    const { db } = makeDb(responder({ steps: [planStep('s1')] }));
    expect(await rerunStep(scopeWith(db), 'run-1', 'nope', { db })).toMatchObject({ ok: false, code: 'not_found' });
  });
});

describe('editStepInput', () => {
  it('writes a new plan version, keeps finished work and re-queues from the edited step onward', async () => {
    const { db, calls } = makeDb(responder({
      run: { ...RUN, state: 'awaiting_approval' },
      steps: [
        planStep('s1', { status: 'completed', result_json: { summary: 'done' }, sequence: 0 }),
        planStep('s2', { status: 'awaiting_approval', approval_id: 'appr-1', sequence: 1, dependency_ids: ['s1'] }),
        planStep('s3', { status: 'queued', sequence: 2, dependency_ids: ['s2'] }),
      ],
      plans: [{ id: 'plan-1', version: 1 }],
    }));

    const result = await editStepInput(scopeWith(db), 'run-1', 's2', { title: 'Dinner at 7' }, { db });

    expect(result).toMatchObject({ ok: true, data: { planId: 'plan-2', version: 2, requeuedSteps: 2 } });

    // Version 1 is superseded, not mutated: the family approved it as it was.
    expect(find(calls, 'ai_plans', 'update')[0].payload).toMatchObject({ status: 'superseded' });
    expect(find(calls, 'ai_plans', 'insert')[0].payload).toMatchObject({ version: 2, request_id: 'req-1' });

    const inserted = find(calls, 'ai_plan_steps', 'insert')[0].payload as Array<Record<string, unknown>>;
    expect(inserted).toHaveLength(3);
    // The finished step keeps its status and result; the edited step and its
    // dependent are queued again because their inputs changed.
    expect(inserted[0]).toMatchObject({ status: 'completed', result_json: { summary: 'done' } });
    expect(inserted[1]).toMatchObject({ status: 'queued', input_json: { title: 'Dinner at 7' }, approval_id: null });
    expect(inserted[2]).toMatchObject({ status: 'queued' });
    // Dependencies survive the re-keying as real uuids of the NEW steps.
    expect(inserted[2].dependency_ids).toEqual([inserted[1].id]);

    expect(find(calls, 'family_automation_runs', 'update')[0].payload).toMatchObject({ plan_id: 'plan-2', state: 'ready' });
    expect(find(calls, 'ai_run_events', 'insert')[0].payload).toMatchObject({ event_type: 'planned' });
  });

  it('refuses to edit a run that has no request to version a plan against', async () => {
    const { db } = makeDb(responder({ run: { ...RUN, request_id: null } }));
    expect(await editStepInput(scopeWith(db), 'run-1', 's1', { title: 'x' }, { db })).toMatchObject({ ok: false, code: 'invalid_input' });
  });

  it('refuses an input that is not an object', async () => {
    const { db } = makeDb(responder({ steps: [planStep('s1')] }));
    expect(await editStepInput(scopeWith(db), 'run-1', 's1', 'not an object', { db })).toMatchObject({ ok: false, code: 'invalid_input' });
  });
});
