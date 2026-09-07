// The executor's control flow, driven through an injected port.
//
// Every assertion here is a promise the product makes to a household: a run
// that ran out of server time keeps its finished work and resumes; a run
// waiting on a parent is not a failure; a transient error is retried a bounded
// number of times and then reported honestly; a cancelled run stops touching
// the household immediately; and a step is never repeated in a way that could
// duplicate a calendar event. None of that can be checked by looking at the
// database after the fact, so the whole outside world is one fake object.
import { describe, expect, it } from 'vitest';
import type { ToolOutcome } from '@/lib/ai/tools/types';
import type { ServiceScope } from '@/lib/services/types';
import { ok, fail } from '@/lib/services/types';
import {
  BUDGET_RESERVE_MS, MAX_REPLANS_PER_RUN, MAX_STEP_CONCURRENCY, evaluateCondition, parseNotifyInput, runGraphWith,
  stepIdempotencyKey, type ExecutorPort, type RunSnapshot, type StepSnapshot,
} from '@/lib/ai/runs/executor';
import type { RunEventInput, RunRow } from '@/lib/ai/runs/store';

/** The executor only reads a `RunSnapshot`, but it WRITES the wider row (status, progress, run_after, ...), and those writes are what the tests assert on. */
type FakeRun = RunSnapshot & Partial<RunRow>;

const FAMILY = 'fam-1';
const RUN_ID = 'run-1';

type ToolCall = { name: string; args: unknown; opts: { idempotencyKey: string; skipTrust: boolean; stepId: string } };

type FakeOptions = {
  steps: Array<Partial<StepSnapshot> & { id: string }>;
  run?: Partial<RunSnapshot>;
  /** Called for every tool invocation; `attempt` is 1-based per step. */
  tool?: (call: ToolCall, attempt: number, fake: Fake) => ToolOutcome | Promise<ToolOutcome>;
  approvals?: Record<string, { status: string; editedPayload?: unknown }>;
  scopeError?: string;
  replan?: ExecutorPort['replan'];
  verify?: ExecutorPort['verify'];
  notify?: ExecutorPort['notifyFamily'];
};

type Fake = {
  port: ExecutorPort;
  run: FakeRun;
  steps: StepSnapshot[];
  events: RunEventInput[];
  calls: ToolCall[];
  approvals: Record<string, { status: string; editedPayload?: unknown }>;
  requestStates: string[];
  heartbeats: number;
  now: number;
  advance(ms: number): void;
  step(id: string): StepSnapshot;
  eventTypes(): string[];
};

function makeStep(partial: Partial<StepSnapshot> & { id: string }, index: number): StepSnapshot {
  return {
    id: partial.id,
    plan_id: 'plan-1',
    sequence: partial.sequence ?? index,
    step_type: partial.step_type ?? 'act',
    tool_name: partial.tool_name ?? 'calendar.createEvent',
    description: partial.description ?? partial.id,
    input_json: partial.input_json ?? {},
    dependency_ids: partial.dependency_ids ?? [],
    condition: partial.condition ?? null,
    status: partial.status ?? 'queued',
    approval_required: partial.approval_required ?? false,
    approval_id: partial.approval_id ?? null,
    risk_level: partial.risk_level ?? 'low',
    retry_count: partial.retry_count ?? 0,
    max_retries: partial.max_retries ?? 2,
    result_json: partial.result_json ?? null,
    error: partial.error ?? null,
  };
}

function makeFake(options: FakeOptions): Fake {
  const attempts = new Map<string, number>();
  const fake = {
    run: {
      id: RUN_ID,
      family_id: FAMILY,
      plan_id: 'plan-1',
      request_id: 'req-1',
      state: 'executing',
      cancel_requested_at: null,
      paused_at: null,
      requested_by_member_id: 'member-1',
      attempt: 1,
      max_attempts: 5,
      lease_owner: 'lease-1',
      ...options.run,
    } as FakeRun,
    steps: options.steps.map(makeStep),
    events: [] as RunEventInput[],
    calls: [] as ToolCall[],
    approvals: options.approvals ?? {},
    requestStates: [] as string[],
    heartbeats: 0,
    now: 1_000_000,
  } as Fake;

  fake.advance = (ms: number) => { fake.now += ms; };
  fake.step = (id: string) => {
    const found = fake.steps.find((s) => s.id === id);
    if (!found) throw new Error(`no step ${id}`);
    return found;
  };
  fake.eventTypes = () => fake.events.map((e) => e.eventType);

  const scope: ServiceScope = {
    db: {} as ServiceScope['db'],
    familyId: FAMILY,
    userId: 'auth-1',
    memberId: 'member-1',
    role: 'parent',
    actorKind: 'ai',
    tz: 'America/New_York',
  };

  fake.port = {
    async loadRun() { return ok({ ...fake.run }); },
    async loadSteps() { return ok(fake.steps.map((s) => ({ ...s }))); },
    async updateRun(_run, patch) { Object.assign(fake.run, patch); },
    async updateStep(_run, stepId, patch) { Object.assign(fake.step(stepId), patch); },
    async appendEvent(_run, event) { fake.events.push(event); },
    async heartbeat() { fake.heartbeats += 1; },
    async scopeFor() {
      return options.scopeError ? fail(options.scopeError, { code: 'denied' }) : ok(scope);
    },
    async runTool(_scope, name, args, opts) {
      const call: ToolCall = { name, args, opts: { idempotencyKey: opts.idempotencyKey, skipTrust: opts.skipTrust, stepId: opts.stepId } };
      fake.calls.push(call);
      const attempt = (attempts.get(opts.stepId) ?? 0) + 1;
      attempts.set(opts.stepId, attempt);
      const handler = options.tool ?? (() => ({ status: 'ok', data: { id: `res-${opts.stepId}` }, summary: `did ${name}`, toolCallId: 'tc-1' } as ToolOutcome));
      return handler(call, attempt, fake);
    },
    async requestApproval(_scope, _run, step) {
      const id = `appr-${step.id}`;
      fake.approvals[id] = fake.approvals[id] ?? { status: 'pending' };
      return ok({ id });
    },
    async loadApproval(_scope, approvalId) {
      const found = fake.approvals[approvalId];
      return ok(found ? { id: approvalId, status: found.status, editedPayload: found.editedPayload ?? null } : null);
    },
    notifyFamily: options.notify ?? (async () => ok({ created: 2 })),
    verify: options.verify ?? (async () => ok({ verified: true, detail: 'All 1 checks passed.', checks: [] })),
    replan: options.replan ?? null,
    async setRequestState(_run, state) { fake.requestStates.push(state); },
    now: () => fake.now,
    async sleep(ms) { fake.advance(ms); },
    random: () => 0.5,
  };

  return fake;
}

const okOutcome = (summary = 'done'): ToolOutcome => ({ status: 'ok', data: { id: 'res-1' }, summary, toolCallId: 'tc-1' });

describe('a straightforward run', () => {
  it('walks the graph in dependency order and reports completed', async () => {
    const fake = makeFake({
      steps: [
        { id: 's1', description: 'Create the event' },
        { id: 's2', description: 'Add the reminder', dependency_ids: ['s1'] },
      ],
    });

    const result = await runGraphWith(fake.port, RUN_ID, { budgetMs: 60_000 });

    expect(fake.calls.map((c) => c.opts.stepId)).toEqual(['s1', 's2']);
    expect(result).toMatchObject({ status: 'completed', completed: 2, failed: 0 });
    expect(fake.run.state).toBe('completed');
    // The legacy 0022 column moves with it, so the concierge panel stops
    // showing a finished run as pending.
    expect(fake.run.status).toBe('executed');
    // The outcome goes in `result`; `summary` stays the run's human label.
    expect(fake.run.result).toMatchObject({ state: 'completed', detail: '2 of 2 steps completed.', total: 2 });
    expect(fake.run.summary).toBeUndefined();
    expect(fake.eventTypes()).toEqual([
      'run_started', 'step_started', 'step_completed', 'step_started', 'step_completed', 'run_completed',
    ]);
    expect(fake.requestStates.at(-1)).toBe('completed');
  });

  it('runs independent steps together, but never more than the concurrency cap', async () => {
    let inFlight = 0;
    let peak = 0;
    const fake = makeFake({
      steps: Array.from({ length: 6 }, (_, i) => ({ id: `s${i}` })),
      tool: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => { setTimeout(resolve, 0); });
        inFlight -= 1;
        return okOutcome();
      },
    });

    const result = await runGraphWith(fake.port, RUN_ID, { budgetMs: 60_000 });

    expect(result.status).toBe('completed');
    expect(peak).toBe(MAX_STEP_CONCURRENCY);
    expect(fake.calls).toHaveLength(6);
  });

  it('skips a step whose condition is not met and still runs what depends on it', async () => {
    const fake = makeFake({
      steps: [
        { id: 's1', description: 'Check the trip' },
        { id: 's2', description: 'Passport reminder', dependency_ids: ['s1'], condition: { path: 'deps[0].international', eq: true } },
        { id: 's3', description: 'Pack list', dependency_ids: ['s2'] },
      ],
      tool: () => ({ status: 'ok', data: { id: 'trip-1' }, summary: 'domestic trip', toolCallId: 'tc-1' }),
    });

    const result = await runGraphWith(fake.port, RUN_ID, { budgetMs: 60_000 });

    expect(fake.step('s2').status).toBe('skipped');
    // A skipped dependency still satisfies its dependents.
    expect(fake.step('s3').status).toBe('completed');
    expect(result.status).toBe('completed');
    expect(fake.eventTypes()).toContain('step_skipped');
  });
});

describe('work that never finished', () => {
  it('picks a step back up when a worker died mid-flight, instead of finishing around it', async () => {
    // The lease this pass holds means no other worker can be running these
    // steps, so a step still `executing` at claim time was interrupted. It is
    // invisible to `selectRunnableSteps` and to `blockedSteps`, so the run used
    // to reach "nothing left to run" and finalize as `completed` — Bubaly
    // telling a family it finished work it never did.
    const fake = makeFake({
      steps: [
        { id: 's1', description: 'Create the event', status: 'executing' },
        { id: 's2', description: 'Add the reminder', dependency_ids: ['s1'] },
      ],
    });

    const result = await runGraphWith(fake.port, RUN_ID, { budgetMs: 60_000 });

    expect(fake.eventTypes()).toContain('step_retried');
    expect(fake.calls.map((c) => c.opts.stepId)).toEqual(['s1', 's2']);
    expect(result).toMatchObject({ status: 'completed', completed: 2 });
  });

  it('does not loop on a step that keeps killing its worker', async () => {
    const fake = makeFake({
      steps: [{ id: 's1', description: 'Create the event', status: 'executing', retry_count: 2, max_retries: 2 }],
    });

    const result = await runGraphWith(fake.port, RUN_ID, { budgetMs: 60_000 });

    expect(fake.step('s1').status).toBe('failed');
    expect(fake.calls).toHaveLength(0);
    expect(result).toMatchObject({ status: 'failed' });
  });

  it('a write it could not confirm is not a completed step, and not a completed run', async () => {
    // §13: `executeTool` re-reads what the tool claims it wrote. The verdict
    // used to go into an event payload nothing renders while the step was
    // marked completed regardless — a calendar event whose re-read did not
    // match still produced a green run.
    const fake = makeFake({
      steps: [
        { id: 's1', description: 'Create the event' },
        { id: 's2', description: 'Add the reminder', dependency_ids: ['s1'] },
      ],
      tool: (call) => (call.opts.stepId === 's1'
        ? { status: 'ok', data: { id: 'res-1' }, summary: 'Added soccer Saturday', toolCallId: 'tc-1', verified: false }
        : { status: 'ok', data: { id: 'res-2' }, summary: 'Set the reminder', toolCallId: 'tc-2' }),
    });

    const result = await runGraphWith(fake.port, RUN_ID, { budgetMs: 60_000 });

    expect(fake.step('s1').status).toBe('partially_completed');
    expect(fake.eventTypes()).toContain('verification_failed');
    // The write happened, so the plan carries on — but the run says so.
    expect(fake.calls.map((c) => c.opts.stepId)).toEqual(['s1', 's2']);
    expect(result.status).toBe('partially_completed');
    expect(String((fake.run.result as { detail: string }).detail)).toContain('could not be confirmed');
  });

  it('shows "Checking the work" while a verify step reads the household back', async () => {
    const seen: string[] = [];
    const fake = makeFake({
      steps: [{ id: 'v1', step_type: 'verify', tool_name: null, input_json: { checks: [{ kind: 'count_at_least', table: 'meal_plans', min: 1 }] } }],
    });
    const original = fake.port.verify;
    fake.port.verify = async (...args: Parameters<typeof original>) => {
      seen.push(fake.step('v1').status);
      return original(...args);
    };

    await runGraphWith(fake.port, RUN_ID, { budgetMs: 60_000 });

    expect(seen).toEqual(['verifying']);
    expect(fake.step('v1').status).toBe('completed');
  });
});

describe('a step using what an earlier step produced', () => {
  it('passes the real id to the tool, not the marker', async () => {
    const fake = makeFake({
      steps: [
        { id: 's1', description: 'Create the trip', tool_name: 'trips.findOrCreateVacation' },
        { id: 's2', description: 'Build the packing list', tool_name: 'trips.createPackingList',
          dependency_ids: ['s1'], input_json: { vacation_id: { $fromStep: 's1', path: 'id' }, member: 'Maya' } },
      ],
      tool: (call) => ({ status: 'ok', data: { id: call.opts.stepId === 's1' ? 'trip-9' : 'list-1' }, summary: 'done', toolCallId: 'tc' }),
    });

    await runGraphWith(fake.port, RUN_ID, { budgetMs: 60_000 });

    const second = fake.calls.find((c) => c.opts.stepId === 's2');
    expect(second?.args).toEqual({ vacation_id: 'trip-9', member: 'Maya' });
  });

  it('fails the step rather than calling a tool with a hole in it', async () => {
    // Passing an unresolved reference to a database is how a run writes the
    // wrong row — or no row — and still reports success.
    const fake = makeFake({
      steps: [
        { id: 's1', description: 'Create the trip' },
        { id: 's2', description: 'Build the packing list', dependency_ids: ['s1'],
          input_json: { vacation_id: { $fromStep: 's1', path: 'nope' } } },
      ],
      tool: () => ({ status: 'ok', data: { id: 'trip-9' }, summary: 'done', toolCallId: 'tc' }),
    });

    const result = await runGraphWith(fake.port, RUN_ID, { budgetMs: 60_000 });

    expect(fake.calls.map((c) => c.opts.stepId)).toEqual(['s1']);
    expect(fake.step('s2').status).toBe('failed');
    expect(String(fake.step('s2').error)).toContain('was not in what the step it depends on produced');
    expect(result.status).toBe('partially_completed');
  });

  it('lets a verify step name the rows this run wrote', async () => {
    // The whole point: `records_exist` on ids this run produced, instead of a
    // family-wide count that last week's rows already satisfy.
    let seen: unknown = null;
    const fake = makeFake({
      steps: [
        { id: 's1', description: 'Add the travel dates', tool_name: 'calendar.createEvent' },
        { id: 'v1', step_type: 'verify', tool_name: null, dependency_ids: ['s1'],
          input_json: { checks: [{ kind: 'records_exist', table: 'calendar_events', ids: [{ $fromStep: 's1', path: 'id' }] }] } },
      ],
      // A real uuid, because `records_exist` requires one — which is the
      // schema refusing to check something it cannot address.
      tool: () => ({ status: 'ok', data: { id: '11111111-1111-4111-8111-111111111111' }, summary: 'done', toolCallId: 'tc' }),
      verify: async (_scope, spec) => { seen = spec; return ok({ verified: true, detail: 'All 1 records are there.', checks: [] }); },
    });

    await runGraphWith(fake.port, RUN_ID, { budgetMs: 60_000 });

    expect(seen).toEqual({ checks: [{ kind: 'records_exist', table: 'calendar_events', ids: ['11111111-1111-4111-8111-111111111111'] }] });
    expect(fake.step('v1').status).toBe('completed');
  });
});

describe('approvals', () => {
  it('parks the run instead of failing it, and does not touch the household', async () => {
    const fake = makeFake({
      steps: [
        { id: 's1', description: 'Book the plumber', approval_required: true },
        { id: 's2', description: 'Tell the family', dependency_ids: ['s1'] },
      ],
    });

    const result = await runGraphWith(fake.port, RUN_ID, { budgetMs: 60_000 });

    expect(result.status).toBe('awaiting_approval');
    expect(result.awaitingApproval).toBe(1);
    expect(fake.calls).toHaveLength(0);              // nothing was done yet
    expect(fake.step('s1').status).toBe('awaiting_approval');
    expect(fake.step('s1').approval_id).toBe('appr-s1');
    expect(fake.step('s2').status).toBe('queued');   // the dependent is untouched
    expect(fake.run.state).toBe('awaiting_approval');
    expect(fake.run.status).toBe('pending');
    expect(fake.run.completed_at ?? null).toBeNull(); // parked, not finished
    expect(fake.eventTypes()).toContain('approval_requested');
  });

  it('resumes on the decision and executes without asking a second time', async () => {
    const fake = makeFake({
      steps: [
        { id: 's1', description: 'Book the plumber', approval_required: true },
        { id: 's2', description: 'Tell the family', dependency_ids: ['s1'] },
      ],
    });
    await runGraphWith(fake.port, RUN_ID, { budgetMs: 60_000 });

    // A manager approves; the approvals service puts the run back in the queue.
    fake.approvals['appr-s1'] = { status: 'approved' };
    fake.run.state = 'ready';
    fake.run.attempt = 2;

    const result = await runGraphWith(fake.port, RUN_ID, { budgetMs: 60_000 });

    expect(result.status).toBe('completed');
    expect(fake.calls).toHaveLength(2);
    // The decided step is executed with the trust gate skipped: re-gating would
    // open a second approval for work the family already said yes to.
    expect(fake.calls[0]).toMatchObject({ opts: { stepId: 's1', skipTrust: true } });
    expect(fake.calls[1]).toMatchObject({ opts: { stepId: 's2', skipTrust: false } });
    expect(fake.eventTypes().filter((t) => t === 'approval_requested')).toHaveLength(1);
    expect(fake.eventTypes()).toContain('approval_decided');
  });

  it('cancels the step when the request is rejected, and reports partial completion', async () => {
    const fake = makeFake({
      steps: [
        { id: 's1', description: 'Send the email', approval_required: true },
        { id: 's2', description: 'Add a note' },
      ],
    });
    await runGraphWith(fake.port, RUN_ID, { budgetMs: 60_000 });

    fake.approvals['appr-s1'] = { status: 'rejected' };
    fake.run.state = 'ready';
    fake.run.attempt = 2;

    const result = await runGraphWith(fake.port, RUN_ID, { budgetMs: 60_000 });

    expect(fake.step('s1').status).toBe('cancelled');
    expect(fake.calls.map((c) => c.opts.stepId)).toEqual(['s2']);
    expect(result.status).toBe('partially_completed');
  });

  it('honours the payload a manager edited instead of the original input', async () => {
    const fake = makeFake({
      // The gate was opened on an earlier pass; a manager then chose Edit.
      steps: [{ id: 's1', description: 'Book at 6pm', approval_required: true, approval_id: 'appr-s1', input_json: { at: '18:00' } }],
      approvals: { 'appr-s1': { status: 'modified', editedPayload: { at: '19:30' } } },
    });

    await runGraphWith(fake.port, RUN_ID, { budgetMs: 60_000 });

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].args).toEqual({ at: '19:30' });
  });

  it('parks on an approval the tool itself opened', async () => {
    const fake = makeFake({
      steps: [{ id: 's1', description: 'Spend $60' }],
      tool: () => ({ status: 'pending_approval', approvalId: 'appr-trust', summary: 'Needs a parent to approve', toolCallId: null }),
    });

    const result = await runGraphWith(fake.port, RUN_ID, { budgetMs: 60_000 });

    expect(result.status).toBe('awaiting_approval');
    expect(fake.step('s1').approval_id).toBe('appr-trust');
    expect(fake.run.state).toBe('awaiting_approval');
  });
});

describe('failure handling', () => {
  it('retries a retryable error a bounded number of times, then fails honestly', async () => {
    const fake = makeFake({
      steps: [{ id: 's1', description: 'Send the message', max_retries: 2 }],
      tool: () => ({ status: 'error', error: 'The provider timed out.', retryable: true, toolCallId: null }),
    });

    const result = await runGraphWith(fake.port, RUN_ID, { budgetMs: 60_000 });

    // max_retries = 2 means three attempts in total, and then it stops.
    expect(fake.calls).toHaveLength(3);
    expect(fake.step('s1').status).toBe('failed');
    expect(fake.step('s1').retry_count).toBe(2);
    expect(fake.eventTypes().filter((t) => t === 'step_retried')).toHaveLength(2);
    expect(result).toMatchObject({ status: 'failed', failed: 1 });
    expect(fake.run.error).toBe('0 of 1 step completed — 1 failed.');
  });

  it('uses the same idempotency key on every attempt, so a retry cannot duplicate a write', async () => {
    const fake = makeFake({
      steps: [{ id: 's1', tool_name: 'calendar.createEvent', max_retries: 2 }],
      tool: () => ({ status: 'error', error: 'Connection reset.', retryable: true, toolCallId: null }),
    });

    await runGraphWith(fake.port, RUN_ID, { budgetMs: 60_000 });

    const keys = new Set(fake.calls.map((c) => c.opts.idempotencyKey));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toBe(stepIdempotencyKey(FAMILY, RUN_ID, 's1', 'calendar.createEvent'));
  });

  it('never retries a denial', async () => {
    const fake = makeFake({
      steps: [{ id: 's1', description: 'Move money', max_retries: 3 }],
      tool: () => ({ status: 'denied', reason: 'Children cannot move money.', toolCallId: null }),
    });

    const result = await runGraphWith(fake.port, RUN_ID, { budgetMs: 60_000 });

    expect(fake.calls).toHaveLength(1);
    expect(fake.step('s1').status).toBe('failed');
    expect(result.status).toBe('failed');
  });

  it('never retries an error the tool called permanent', async () => {
    const fake = makeFake({
      steps: [{ id: 's1', max_retries: 3 }],
      tool: () => ({ status: 'error', error: 'That list no longer exists.', retryable: false, toolCallId: null }),
    });

    await runGraphWith(fake.port, RUN_ID, { budgetMs: 60_000 });
    expect(fake.calls).toHaveLength(1);
  });

  it('blocks the tail behind a failure and reports "1 of 3"', async () => {
    const fake = makeFake({
      steps: [
        { id: 's1', description: 'Independent note' },
        { id: 's2', description: 'The one that breaks', max_retries: 0 },
        { id: 's3', description: 'Depends on the broken one', dependency_ids: ['s2'] },
      ],
      tool: (call) => (call.opts.stepId === 's2'
        ? { status: 'error', error: 'Upstream refused.', retryable: false, toolCallId: null }
        : okOutcome()),
    });

    const result = await runGraphWith(fake.port, RUN_ID, { budgetMs: 60_000 });

    expect(fake.step('s3').status).toBe('blocked');
    expect(fake.calls.map((c) => c.opts.stepId)).toEqual(['s1', 's2']);
    expect(result).toMatchObject({ status: 'partially_completed', completed: 1, failed: 1 });
    expect(fake.run.result).toMatchObject({ state: 'partially_completed', detail: '1 of 3 steps completed — 1 failed, 1 blocked.' });
  });

  it('refuses to run a plan whose steps depend on each other in a loop', async () => {
    const fake = makeFake({
      steps: [
        { id: 's1', dependency_ids: ['s2'] },
        { id: 's2', dependency_ids: ['s1'] },
      ],
    });

    const result = await runGraphWith(fake.port, RUN_ID, { budgetMs: 60_000 });

    expect(result.status).toBe('failed');
    expect(fake.calls).toHaveLength(0);
    expect(String(fake.run.error)).toContain('loop');
  });

  it('blocks a run whose requester is no longer an active member', async () => {
    const fake = makeFake({
      steps: [{ id: 's1' }],
      scopeError: 'The person who asked for this is no longer an active member of the family.',
    });

    const result = await runGraphWith(fake.port, RUN_ID, { budgetMs: 60_000 });

    expect(result.status).toBe('blocked');
    expect(fake.run.state).toBe('blocked');
    expect(fake.calls).toHaveLength(0);
    expect(fake.eventTypes()).toContain('blocked');
  });
});

describe('the wall clock', () => {
  it('parks with exact state when the budget runs out, and finishes on the next pass', async () => {
    const fake = makeFake({
      steps: [
        { id: 's1', description: 'One' },
        { id: 's2', description: 'Two', dependency_ids: ['s1'] },
        { id: 's3', description: 'Three', dependency_ids: ['s2'] },
      ],
      tool: (_call, _attempt, f) => { f.advance(20_000); return okOutcome(); },
    });

    const first = await runGraphWith(fake.port, RUN_ID, { budgetMs: 45_000 });

    // Two steps fit; the third would not leave time to persist.
    expect(first.status).toBe('ready');
    expect(fake.calls).toHaveLength(2);
    expect(fake.step('s1').status).toBe('completed');
    expect(fake.step('s3').status).toBe('queued');
    expect(fake.run.state).toBe('ready');
    expect(fake.run.run_after).toBeTruthy();
    // The lease is handed back so the next tick can pick it up immediately.
    expect(fake.run.lease_owner).toBeNull();
    expect(fake.run.progress).toMatchObject({ completed: 2, total: 3 });
    expect(fake.eventTypes()).toContain('followup_scheduled');

    const second = await runGraphWith(fake.port, RUN_ID, { budgetMs: 45_000 });

    expect(second.status).toBe('completed');
    expect(fake.calls).toHaveLength(3);
    expect(fake.run.result).toMatchObject({ detail: '3 of 3 steps completed.' });
  });

  it('parks rather than sleeping past the deadline when a retry backoff will not fit', async () => {
    const fake = makeFake({
      // Five attempts in already, so the next backoff is eight seconds - longer
      // than what is left of this invocation.
      steps: [{ id: 's1', max_retries: 8, retry_count: 5 }],
      tool: (_call, _attempt, f) => {
        f.advance(9_000);
        return { status: 'error', error: 'Rate limited.', retryable: true, toolCallId: null };
      },
    });

    const result = await runGraphWith(fake.port, RUN_ID, { budgetMs: 12_000 + BUDGET_RESERVE_MS });

    expect(result.status).toBe('ready');
    expect(fake.calls).toHaveLength(1);
    expect(fake.step('s1').status).toBe('ready');
    expect(fake.step('s1').retry_count).toBe(6); // the attempt is banked across invocations
  });

  it('schedules a follow-up step for later instead of waiting on it', async () => {
    const fake = makeFake({
      steps: [
        { id: 's1' },
        { id: 's2', step_type: 'followup', tool_name: null, dependency_ids: ['s1'], input_json: { delayMinutes: 120 } },
        { id: 's3', dependency_ids: ['s2'] },
      ],
    });

    const result = await runGraphWith(fake.port, RUN_ID, { budgetMs: 60_000 });

    expect(result.status).toBe('scheduled_followup');
    expect(fake.run.state).toBe('scheduled_followup');
    expect(new Date(String(fake.run.run_after)).getTime()).toBe(fake.now + 120 * 60_000);
    expect(fake.step('s3').status).toBe('queued');
  });
});

describe('cancellation', () => {
  it('stops the queued steps as soon as the cancel lands, mid-run', async () => {
    const fake = makeFake({
      steps: [
        { id: 's1', description: 'First' },
        { id: 's2', description: 'Second', dependency_ids: ['s1'] },
        { id: 's3', description: 'Third', dependency_ids: ['s2'] },
      ],
      tool: (call, _attempt, f) => {
        // A person cancels while the first step is running.
        if (call.opts.stepId === 's1') f.run.cancel_requested_at = new Date().toISOString();
        return okOutcome();
      },
    });

    const result = await runGraphWith(fake.port, RUN_ID, { budgetMs: 60_000 });

    expect(fake.calls.map((c) => c.opts.stepId)).toEqual(['s1']);
    expect(fake.step('s1').status).toBe('completed');  // finished work is kept
    expect(fake.step('s2').status).toBe('cancelled');
    expect(fake.step('s3').status).toBe('cancelled');
    expect(result.status).toBe('cancelled');
    expect(fake.run.state).toBe('cancelled');
    expect(fake.eventTypes()).toContain('cancelled');
  });

  it('does nothing at all to a run that was cancelled before it was claimed', async () => {
    const fake = makeFake({
      steps: [{ id: 's1' }, { id: 's2' }],
      run: { cancel_requested_at: '2026-09-05T10:00:00Z' },
    });

    const result = await runGraphWith(fake.port, RUN_ID, { budgetMs: 60_000 });

    expect(fake.calls).toHaveLength(0);
    expect(result.status).toBe('cancelled');
    expect(fake.steps.every((s) => s.status === 'cancelled')).toBe(true);
  });

  it('leaves a paused run exactly where it is', async () => {
    const fake = makeFake({ steps: [{ id: 's1' }], run: { state: 'paused', paused_at: '2026-09-05T10:00:00Z' } });
    const result = await runGraphWith(fake.port, RUN_ID, { budgetMs: 60_000 });
    expect(result.status).toBe('paused');
    expect(fake.calls).toHaveLength(0);
    expect(fake.step('s1').status).toBe('queued');
  });

  it('does not re-execute a run that already finished', async () => {
    const fake = makeFake({ steps: [{ id: 's1', status: 'completed' }], run: { state: 'completed' } });
    const result = await runGraphWith(fake.port, RUN_ID, { budgetMs: 60_000 });
    expect(result.status).toBe('completed');
    expect(fake.calls).toHaveLength(0);
    expect(fake.events).toHaveLength(0);
  });
});

describe('verify, notify and replan steps', () => {
  it('fails the run when verification says the household is not in the promised state', async () => {
    const fake = makeFake({
      steps: [
        { id: 's1', description: 'Create the events' },
        {
          id: 's2', step_type: 'verify', tool_name: null, dependency_ids: ['s1'],
          input_json: { checks: [{ kind: 'records_exist', table: 'calendar_events', ids: ['11111111-1111-4111-8111-111111111111'] }] },
        },
      ],
      verify: async () => ok({ verified: false, detail: '0 of 1 checks passed — 1 of 1 records are missing.', checks: [] }),
    });

    const result = await runGraphWith(fake.port, RUN_ID, { budgetMs: 60_000 });

    expect(fake.step('s2').status).toBe('failed');
    expect(result.status).toBe('partially_completed');
    expect(fake.eventTypes()).toContain('verification_failed');
  });

  it('sends a notify step through the notifications service', async () => {
    const fake = makeFake({
      steps: [{
        id: 's1', step_type: 'notify', tool_name: null,
        input_json: { recipients: 'family', type: 'system', title: 'Your week is planned' },
      }],
    });

    const result = await runGraphWith(fake.port, RUN_ID, { budgetMs: 60_000 });

    expect(result.status).toBe('completed');
    expect(fake.eventTypes()).toContain('notified');
    expect(fake.step('s1').result_json).toMatchObject({ count: 2 });
  });

  it('blocks a replan step rather than pretending it re-planned', async () => {
    const fake = makeFake({
      steps: [{ id: 's1', step_type: 'replan', tool_name: null }, { id: 's2', dependency_ids: ['s1'] }],
    });

    const result = await runGraphWith(fake.port, RUN_ID, { budgetMs: 60_000 });

    expect(fake.step('s1').status).toBe('blocked');
    expect(fake.step('s2').status).toBe('blocked');
    expect(result.status).toBe('failed');
  });

  it('follows a replanner to the new plan version when one is wired in', async () => {
    const fake = makeFake({
      steps: [{ id: 's1', step_type: 'replan', tool_name: null }],
      replan: async () => ok({ planId: 'plan-2' }),
    });

    const result = await runGraphWith(fake.port, RUN_ID, { budgetMs: 60_000 });

    expect(fake.run.plan_id).toBe('plan-2');
    expect(fake.step('s1').status).toBe('completed');
    expect(result.status).toBe('completed');
    expect(fake.eventTypes()).toContain('planned');
  });
});

describe('condition and notify parsing', () => {
  it('treats a malformed condition as unmet rather than met', () => {
    const context = { deps: [{ international: true }], dep: {}, input: {} };
    expect(evaluateCondition({ path: 'deps[0].international', eq: true }, context).pass).toBe(true);
    expect(evaluateCondition({ path: 'deps[0].international', eq: false }, context).pass).toBe(false);
    expect(evaluateCondition({ path: 'deps[0].missing', exists: false }, context).pass).toBe(true);
    expect(evaluateCondition({ nonsense: 1 }, context).pass).toBe(false);
    expect(evaluateCondition('not an object', context).pass).toBe(false);
    expect(evaluateCondition({ path: 'deps[0].international' }, context).pass).toBe(false);
    // No condition at all is not a barrier.
    expect(evaluateCondition(null, context).pass).toBe(true);
  });

  it('refuses a notification with nobody to tell or nothing to say', () => {
    expect(parseNotifyInput({ title: 'Hi', recipients: [] }).ok).toBe(false);
    expect(parseNotifyInput({ recipients: 'family' }).ok).toBe(false);
    expect(parseNotifyInput(null).ok).toBe(false);
    const parsed = parseNotifyInput({ recipients: 'managers', title: 'Hi', type: 'not_a_real_enum_value' });
    expect(parsed.ok).toBe(true);
    // An unknown enum value would be rejected by Postgres after the step already
    // reported success, so it degrades to the generic bucket.
    if (parsed.ok) expect(parsed.data.type).toBe('system');
  });
});

describe('re-planning through a wired port', () => {
  const SETTLED = ['completed', 'skipped', 'failed', 'cancelled', 'partially_completed'];

  /**
   * A replanner shaped like `replanRun`: version N+1 carries every settled
   * step and the replan step itself (completed), then the fresh work. The
   * fake's step list IS the plan the executor reloads, so swapping it is the
   * new version landing.
   */
  function replanLike(holder: { fake: Fake | null }, fresh: Array<Partial<StepSnapshot> & { id: string }>, seen?: { steps: StepSnapshot[] }[]): ExecutorPort['replan'] {
    return async (_scope, _run, step, steps) => {
      const fake = holder.fake!;
      seen?.push({ steps: steps.map((s) => ({ ...s })) });
      const carried = steps.filter((s) => s.id !== step.id && SETTLED.includes(s.status)).map((s) => ({ ...s, plan_id: 'plan-2' }));
      const decision = { ...fake.step(step.id), plan_id: 'plan-2', status: 'completed' as const, result_json: { summary: 'Re-planned the rest of this run.' } };
      fake.steps = [...carried, decision, ...fresh.map((s, i) => ({ ...makeStep(s, carried.length + 1 + i), plan_id: 'plan-2' }))];
      return ok({ planId: 'plan-2' });
    };
  }

  it('continues into the new plan version: the fresh steps run in the same pass, ledgered under the new plan', async () => {
    const holder: { fake: Fake | null } = { fake: null };
    const fake = makeFake({
      steps: [
        { id: 'r1', step_type: 'retrieve', tool_name: 'calendar.searchEvents', description: 'Read the week' },
        { id: 'p2', step_type: 'replan', tool_name: null, dependency_ids: ['r1'], input_json: { prompt: 'Decide what the week needs' } },
      ],
      replan: replanLike(holder, [
        { id: 'a3', step_type: 'act', tool_name: 'tasks.createTodo', description: 'Add the to-do' },
        { id: 'n4', step_type: 'notify', tool_name: null, dependency_ids: ['a3'], input_json: { recipients: 'managers', type: 'system', title: 'Done' } },
      ]),
    });
    holder.fake = fake;

    const result = await runGraphWith(fake.port, RUN_ID, { budgetMs: 60_000 });

    expect(fake.run.plan_id).toBe('plan-2');
    expect(fake.calls.map((c) => c.opts.stepId)).toEqual(['r1', 'a3']);
    expect(fake.step('p2').status).toBe('completed');
    expect(fake.step('a3').status).toBe('completed');
    expect(fake.step('n4').status).toBe('completed');
    expect(result).toMatchObject({ status: 'completed', completed: 4, failed: 0 });
    const planned = fake.events.find((e) => e.eventType === 'planned');
    expect(planned?.payload).toMatchObject({ plan_id: 'plan-2', replans: 1, limit: MAX_REPLANS_PER_RUN });
    expect(fake.eventTypes()).not.toContain('blocked');
  });

  it('runs the replan step alone and last, so it sees every other step settled', async () => {
    const holder: { fake: Fake | null } = { fake: null };
    const seen: { steps: StepSnapshot[] }[] = [];
    const order: string[] = [];
    const fake = makeFake({
      steps: [
        { id: 'r1', step_type: 'retrieve', tool_name: 'calendar.searchEvents' },
        { id: 'r2', step_type: 'retrieve', tool_name: 'tasks.searchTodos' },
        { id: 'a3', step_type: 'act', tool_name: 'tasks.createTodo' },
        { id: 'p4', step_type: 'replan', tool_name: null, dependency_ids: ['r1'] },
      ],
      tool: async (call) => { order.push(call.opts.stepId); return okOutcome(); },
      replan: async (scope, run, step, steps) => { order.push('replan'); return replanLike(holder, [], seen)!(scope, run, step, steps); },
    });
    holder.fake = fake;

    const result = await runGraphWith(fake.port, RUN_ID, { budgetMs: 60_000 });

    // r1, r2 and a3 are one batch; the replan waits for the batch even though
    // its only dependency (r1) was satisfied first.
    expect(order.slice(0, 3).sort()).toEqual(['a3', 'r1', 'r2']);
    expect(order[3]).toBe('replan');
    expect(seen).toHaveLength(1);
    expect(seen[0].steps.filter((s) => s.id !== 'p4').every((s) => s.status === 'completed')).toBe(true);
    expect(result.status).toBe('completed');
  });

  it('parks instead of re-planning while a step is waiting on a person, and re-plans once they decide', async () => {
    const holder: { fake: Fake | null } = { fake: null };
    const seen: { steps: StepSnapshot[] }[] = [];
    const fake = makeFake({
      steps: [
        { id: 'r1', step_type: 'retrieve', tool_name: 'calendar.searchEvents' },
        { id: 'a2', step_type: 'act', tool_name: 'finances.updateBudget', approval_required: true },
        { id: 'p3', step_type: 'replan', tool_name: null, dependency_ids: ['r1'] },
      ],
      replan: replanLike(holder, [{ id: 'a4', step_type: 'act', tool_name: 'tasks.createTodo' }], seen),
    });
    holder.fake = fake;

    const parked = await runGraphWith(fake.port, RUN_ID, { budgetMs: 60_000 });

    expect(parked.status).toBe('awaiting_approval');
    expect(seen).toHaveLength(0);
    expect(fake.step('p3').status).toBe('queued');
    expect(fake.step('a2').status).toBe('awaiting_approval');
    expect(fake.run.state).toBe('awaiting_approval');

    // The person says yes: the approvals service returns the run to the queue,
    // and the replan step now sees the decision and what it wrote.
    fake.approvals['appr-a2'].status = 'approved';
    fake.run.state = 'ready';
    const resumed = await runGraphWith(fake.port, RUN_ID, { budgetMs: 60_000 });

    expect(seen).toHaveLength(1);
    expect(seen[0].steps.find((s) => s.id === 'a2')?.status).toBe('completed');
    expect(fake.step('a4').status).toBe('completed');
    expect(resumed.status).toBe('completed');
  });

  it('blocks the third re-plan of a run and reports what it managed, without calling the planner', async () => {
    let called = 0;
    const fake = makeFake({
      steps: [
        { id: 'p1', step_type: 'replan', tool_name: null, status: 'completed' },
        { id: 'p2', step_type: 'replan', tool_name: null, status: 'completed' },
        { id: 'r3', step_type: 'retrieve', tool_name: 'calendar.searchEvents' },
        { id: 'p4', step_type: 'replan', tool_name: null, dependency_ids: ['r3'] },
      ],
      replan: async () => { called += 1; return ok({ planId: 'plan-4' }); },
    });

    const result = await runGraphWith(fake.port, RUN_ID, { budgetMs: 60_000 });

    expect(MAX_REPLANS_PER_RUN).toBe(2);
    expect(called).toBe(0);
    expect(fake.step('p4').status).toBe('blocked');
    expect(fake.step('p4').error).toMatch(/already been re-planned 2 times/);
    expect(fake.events.find((e) => e.eventType === 'blocked')?.payload).toMatchObject({ replans: 2, limit: 2 });
    expect(fake.run.plan_id).toBe('plan-1');
    expect(result.status).toBe('partially_completed');
  });

  it('fails the replan step honestly when the planner has nothing more to plan', async () => {
    const fake = makeFake({
      steps: [
        { id: 'r1', step_type: 'retrieve', tool_name: 'calendar.searchEvents' },
        { id: 'p2', step_type: 'replan', tool_name: null, dependency_ids: ['r1'] },
      ],
      replan: async () => fail('Bubaly had nothing more to plan for this request.', { code: 'invalid_input' }),
    });

    const result = await runGraphWith(fake.port, RUN_ID, { budgetMs: 60_000 });

    expect(fake.step('p2').status).toBe('failed');
    expect(fake.step('p2').error).toMatch(/nothing more to plan/);
    expect(fake.run.plan_id).toBe('plan-1');
    expect(result).toMatchObject({ status: 'partially_completed', completed: 1, failed: 1 });
  });
});
