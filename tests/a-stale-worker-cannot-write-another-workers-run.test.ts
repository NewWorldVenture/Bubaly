// A worker that blocked past its lease cannot write the run another worker now
// holds (review on #901, 5971497737).
//
// `attempt` is the run's abandonment budget, and #901 hands it back when a slice
// makes progress. The hand-back is written by the worker, through the
// executor's port, and the production port used to write it the way a person's
// control does — filtered by run id and family, nothing else. A worker's
// authority over the row is not its membership, it is its LEASE, and a lease
// can be lost mid-slice: the executor checks its budget before each step but
// awaits `runTool` without a deadline, so a tool can outlive the lease.
//
// The interleaving the review described, driven here through the real
// `createExecutorPort` over the in-memory client and a predicate-for-predicate
// stand-in for `claim_ai_runs` (0263):
//
//   worker A claims the run at attempt 4 with lease A and blocks inside a tool;
//   A's lease expires;
//   the next tick's `claim_ai_runs` recovers the row and leases it to worker B
//     at attempt 5 with lease B;
//   A's tool returns, A sees the progress it made, and A parks.
//
// Before: A's park wrote `attempt: 0`, `lease_owner: null` over B's live lease.
// A third worker could claim the run while B was still executing it, and the
// budget B was spending was gone. Two things close it. The slice fixes the
// lease it was claimed with and ends, writing nothing, when the per-pass
// refresh shows another lease (`lease_lost`); and every run write the
// production port makes for a leased run is fenced on that lease
// (`updateRunHeldBy`), so the write that races the refresh lands nowhere and
// stops the slice (`RunLeaseLostError`). The owner's own writes pass the fence,
// which the third case shows. Step and timeline writes are not fenced — the
// step table carries no lease — and the one such write A still makes here (its
// completed step) is benign: B's execution of the same step carries the same
// step-scoped idempotency key, so the tool's effect cannot double.
//
// The last case is the second review (4173803806): the hand-back is reached
// only through a claim, so a run that was ALREADY at the ceiling when this
// shipped — `executing`, lease expired, `attempt >= max_attempts`, satisfied
// steps or not — is dead-lettered by the recovery arm before any claim, and
// nothing here repairs it. That is deliberate (executor.ts explains why a
// once-only repair is not available without a marker); a person asking again
// is the way back, and the follow-up change gives that ask a fresh budget.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ToolOutcome } from '@/lib/ai/tools/types';
import { randomUUID } from 'node:crypto';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => { throw new Error('the test hands the port its own client'); },
  createServer: async () => { throw new Error('the test hands the port its own client'); },
}));

const { createExecutorPort, runGraphWith, RunLeaseLostError, RunWriteFailedError } = await import('@/lib/ai/runs/executor');
type ExecutorPort = import('@/lib/ai/runs/executor').ExecutorPort;
type RunSnapshot = import('@/lib/ai/runs/executor').RunSnapshot;

const FAMILY = '00000000-0000-4000-8000-00000000fa05';
const USER = '00000000-0000-4000-8000-0000000000a5';
const PARENT = '00000000-0000-4000-8000-00000000ae05';
const REQUEST = '00000000-0000-4000-8000-00000000cc51';
const PLAN = '00000000-0000-4000-8000-00000000cc52';
const RUN = '00000000-0000-4000-8000-00000000cc53';
const STEP = '00000000-0000-4000-8000-00000000cc54';
const LEASE_A = '00000000-0000-4000-8000-00000000aaaa';
const LEASE_B = '00000000-0000-4000-8000-00000000bbbb';
const NOW = new Date('2026-10-03T12:00:00.000Z');
const CEILING = 5;

const DONE: ToolOutcome = { status: 'ok', data: { id: 'ev-1' }, summary: 'Added the dentist.', toolCallId: 'call-1', verified: true };
const ABANDONED = 'Run abandoned after the maximum number of attempts.';

/**
 * `claim_ai_runs` as 0263 writes it, predicate for predicate (the same stand-in
 * tests/a-run-that-threw-is-not-stranded.test.ts drives the cron with): the
 * recovery pass over `executing` rows whose lease is NOT NULL and past — back
 * to `ready`, or `failed` once `attempt >= max_attempts` — then the candidates
 * from `ready` and `scheduled_followup`, each leased with one more attempt.
 * Rows are the live table objects.
 */
function claimAiRuns(args: Record<string, unknown>, store: InMemorySupabase): string[] {
  const limit = Math.max(1, Math.min(Number(args.p_limit ?? 10), 50));
  const leaseSeconds = Math.max(30, Math.min(Number(args.p_lease_seconds ?? 120), 900));
  const now = Date.now();
  const rows = store.table('family_automation_runs') as Array<Row & { id: string }>;
  for (const r of rows) {
    if (r.state !== 'executing' || r.lease_expires_at == null || Date.parse(String(r.lease_expires_at)) >= now) continue;
    const dead = Number(r.attempt) >= Number(r.max_attempts);
    Object.assign(r, {
      state: dead ? 'failed' : 'ready',
      status: dead ? 'failed' : r.status,
      error: dead ? (r.error ?? ABANDONED) : r.error,
      completed_at: dead ? new Date(now).toISOString() : r.completed_at,
      lease_owner: null, lease_expires_at: null, run_after: new Date(now).toISOString(),
    });
  }
  const candidates = rows
    .filter((r) => (r.state === 'ready' || r.state === 'scheduled_followup')
      && Date.parse(String(r.run_after)) <= now
      && (r.lease_expires_at == null || Date.parse(String(r.lease_expires_at)) < now)
      && r.cancel_requested_at == null)
    .sort((a, b) => String(a.run_after).localeCompare(String(b.run_after)))
    .slice(0, limit);
  for (const r of candidates) {
    Object.assign(r, {
      state: 'executing', attempt: Number(r.attempt) + 1, lease_owner: randomUUID(),
      lease_expires_at: new Date(now + leaseSeconds * 1000).toISOString(), started_at: r.started_at ?? new Date(now).toISOString(),
    });
  }
  return candidates.map((r) => r.id);
}

let db: InMemorySupabase;
const client = () => db as unknown as SupabaseClient<Database>;
const run = () => db.table('family_automation_runs').find((r) => r.id === RUN) as Row;
const request = () => db.table('ai_requests').find((r) => r.id === REQUEST) as Row;
const events = () => db.table('ai_run_events').map((e) => String(e.event_type));
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs).toISOString();

function step(over: Row = {}): Row {
  return {
    id: STEP, family_id: FAMILY, plan_id: PLAN, sequence: 0, step_type: 'act', tool_name: 'calendar.createEvent',
    description: 'Add the dentist', input_json: { title: 'Dentist' }, dependency_ids: [], condition: null,
    status: 'queued', approval_required: false, approval_id: null, risk_level: 'low', retry_count: 0, max_retries: 2,
    result_json: null, error: null, started_at: null, completed_at: null, ...over,
  };
}

/** A household with one run of one plan, the way `scopeFor` wants to find it. */
function seed(runOver: Row, steps: Row[] = [step()]) {
  db.seed('families', [{ id: FAMILY, name: 'Fixture', timezone: 'UTC', created_by: USER }]);
  db.seed('family_members', [{ id: PARENT, family_id: FAMILY, user_id: USER, display_name: 'Dan', role: 'parent', is_active: true }]);
  db.seed('ai_requests', [{ id: REQUEST, family_id: FAMILY, requested_by: USER, requested_by_member_id: PARENT, kind: 'concierge', request_text: 'Add the dentist', status: 'executing', error: null }]);
  db.seed('ai_plans', [{ id: PLAN, family_id: FAMILY, request_id: REQUEST, version: 1, status: 'approved', risk_level: 'low' }]);
  db.seed('ai_plan_steps', steps);
  db.seed('family_automation_runs', [{
    id: RUN, family_id: FAMILY, run_type: 'concierge_plan', plan_id: PLAN, request_id: REQUEST, requested_by_member_id: PARENT,
    state: 'executing', status: 'executing', progress: {}, max_attempts: CEILING, cancel_requested_at: null, paused_at: null,
    started_at: at(-10 * 60_000), completed_at: null, error: null, summary: null, run_after: at(-10 * 60_000), created_by: USER,
    ...runOver,
  }]);
}

/** The real production port over the in-memory client, with the tool under the test's control. */
function worker(tool: () => Promise<ToolOutcome>, over: SupabaseClient<Database> = client()): ExecutorPort {
  const real = createExecutorPort(over);
  return { ...real, runTool: async () => tool() };
}

/**
 * The in-memory client with one fault: every UPDATE of `family_automation_runs`
 * is refused by the database (a connection lost mid-statement), answered the
 * way supabase-js answers it — `{ data: null, error }`, no throw. Every other
 * table, and every read of the runs table, is served as before.
 */
function runWritesRefused(): SupabaseClient<Database> {
  const refusal = { data: null, error: { message: 'connection reset by peer', code: '08006', details: '', hint: '' } };
  return new Proxy(client(), {
    get(target, prop, receiver) {
      if (prop !== 'from') return Reflect.get(target, prop, receiver);
      return (table: string) => {
        const builder = target.from(table as never) as unknown as Record<string, unknown>;
        if (table !== 'family_automation_runs') return builder;
        return new Proxy(builder, {
          get(b, p, r) {
            if (p !== 'update') return Reflect.get(b, p, r);
            return () => {
              // Every filter and modifier chains; awaiting the chain is the refusal.
              const stub: Record<string | symbol, unknown> = new Proxy({}, {
                get: (_target, name) => (name === 'then' ? (resolve: (v: unknown) => unknown) => Promise.resolve(refusal).then(resolve) : () => stub),
              });
              return stub;
            };
          },
        });
      };
    },
  }) as SupabaseClient<Database>;
}

/** A tool the test can hold inside, so the slice is "blocked past its lease" for as long as the test says. */
function heldTool() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  const tool = async (): Promise<ToolOutcome> => { enter(); await released; return DONE; };
  return { tool, entered, release };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  db = createInMemorySupabase({ userId: USER });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('a stale worker cannot write another worker\'s run', () => {
  it('A returns from its tool after the next tick leased the run to B: A ends with lease_lost and B keeps its lease, its attempt and its state', async () => {
    // A claimed at attempt 4 with lease A, and the lease has already run out:
    // A is inside a tool that outlived it.
    seed({ attempt: 4, lease_owner: LEASE_A, lease_expires_at: at(-60_000) });
    const held = heldTool();
    const sliceA = runGraphWith(worker(held.tool), RUN, { budgetMs: 60_000 });
    await held.entered;
    expect(run()).toMatchObject({ state: 'executing', attempt: 4, lease_owner: LEASE_A });

    // The next tick. The recovery arm sees an `executing` run with a lease in
    // the past and puts it back in the queue (attempt 4 < 5); the claiming pass
    // leases it to B at attempt 5, in the same call.
    expect(claimAiRuns({ p_limit: 10, p_lease_seconds: 120 }, db)).toEqual([RUN]);
    const leaseB = run().lease_owner;
    expect(leaseB).toBeTruthy();
    expect(leaseB).not.toBe(LEASE_A);
    expect(run()).toMatchObject({ state: 'executing', attempt: 5, lease_expires_at: at(120_000) });

    // A's tool comes back with a success. A's step is done, A's slice made
    // progress — and that progress is B's run now.
    held.release();
    const result = await sliceA;
    expect(result.status).toBe('lease_lost');

    // B's row, untouched: no park, no reset of the budget, no cleared lease.
    expect(run()).toMatchObject({ state: 'executing', status: 'executing', attempt: 5, lease_owner: leaseB, lease_expires_at: at(120_000), run_after: at(0) });
    expect(events(), 'A recorded no park and no finish').not.toContain('followup_scheduled');
    expect(events()).not.toContain('run_completed');
    expect(request().status, 'and did not move the request either').toBe('executing');
    // A's one unfenced write — its completed step — is the benign one: B's
    // own execution of that step carries the same idempotency key.
    expect(db.table('ai_plan_steps')[0]).toMatchObject({ id: STEP, status: 'completed' });
  });

  it('the write itself is fenced: a park carrying a lease the row no longer has lands nowhere and ends the slice', async () => {
    // The write that races the refresh: A's snapshot still says lease A, the
    // row says lease B. The refresh would have caught this a moment later; the
    // fence catches it now.
    seed({ attempt: 5, lease_owner: LEASE_B, lease_expires_at: at(120_000) });
    const portA = worker(async () => DONE);
    const staleSnapshot: RunSnapshot = { ...(run() as unknown as RunSnapshot), lease_owner: LEASE_A };

    await expect(portA.updateRun(staleSnapshot, { state: 'ready', status: 'approved', attempt: 0, lease_owner: null, lease_expires_at: null, run_after: at(0) }))
      .rejects.toBeInstanceOf(RunLeaseLostError);
    expect(run()).toMatchObject({ state: 'executing', attempt: 5, lease_owner: LEASE_B, lease_expires_at: at(120_000) });
  });

  it('the owner passes the fence: the same park, written by the worker that holds the lease, lands with the budget handed back', async () => {
    // Non-vacuity, and the reason the fence is on the lease and not a ban on
    // writes. A holds a live lease, completes the first step, finds the second
    // (which waited on the first) with too little slice left, and parks:
    // `ready`, lease cleared, `attempt` back to 0 for the progress.
    const STEP_2 = '00000000-0000-4000-8000-00000000cc55';
    seed({ attempt: 4, lease_owner: LEASE_A, lease_expires_at: at(120_000) }, [step(), step({ id: STEP_2, sequence: 1, dependency_ids: [STEP] })]);
    const portA = worker(async () => { vi.setSystemTime(new Date(NOW.getTime() + 15_000)); return DONE; });

    const result = await runGraphWith(portA, RUN, { budgetMs: 20_000 });
    expect(result.status).toBe('ready');
    expect(run()).toMatchObject({ state: 'ready', attempt: 0, lease_owner: null, lease_expires_at: null });
    expect(events()).toContain('followup_scheduled');
  });

  // Review 5981689801: the fence threw for a lease that was gone, but a write the
  // database REFUSED came back `ok: false` and the adapter returned normally, so
  // the slice went on as if the run were parked or reset — appending the
  // follow-up event, telling the request it was ready, reporting a result —
  // with nothing persisted. A refused write is a stopped slice, like a lost
  // lease: the thrown slice is the recovery pass's.
  it('a run write the database refused ends the slice: the adapter throws, and nothing is written', async () => {
    seed({ attempt: 4, lease_owner: LEASE_A, lease_expires_at: at(120_000) });
    const portA = worker(async () => DONE, runWritesRefused());
    const snapshot = run() as unknown as RunSnapshot;

    await expect(portA.updateRun(snapshot, { state: 'ready', status: 'approved', attempt: 0, lease_owner: null, lease_expires_at: null, run_after: at(0) }))
      .rejects.toBeInstanceOf(RunWriteFailedError);
    await expect(portA.updateRun(snapshot, { state: 'ready' })).rejects.toThrow(/^The run 00000000-0000-4000-8000-00000000cc53 could not be written: /);
    expect(run()).toMatchObject({ state: 'executing', attempt: 4, lease_owner: LEASE_A, lease_expires_at: at(120_000) });
    // The unleased write is held to the same rule.
    const unleased = { ...snapshot, lease_owner: null } as RunSnapshot;
    await expect(portA.updateRun(unleased, { state: 'ready' })).rejects.toBeInstanceOf(RunWriteFailedError);
  });

  it('a slice whose park could not be written reports no result and commits nothing after it: no follow-up event, the request untouched, the step as it was before the park', async () => {
    // The full graph: A holds a live lease, completes the first step, finds the
    // second with too little slice left and parks — and the park is refused.
    const STEP_2 = '00000000-0000-4000-8000-00000000cc55';
    seed({ attempt: 4, lease_owner: LEASE_A, lease_expires_at: at(120_000) }, [step(), step({ id: STEP_2, sequence: 1, dependency_ids: [STEP] })]);
    const portA = worker(async () => { vi.setSystemTime(new Date(NOW.getTime() + 15_000)); return DONE; }, runWritesRefused());

    await expect(runGraphWith(portA, RUN, { budgetMs: 20_000 })).rejects.toBeInstanceOf(RunWriteFailedError);
    // The run row is exactly as the claim left it: still executing under A's
    // lease, its budget not handed back, nothing says "ready".
    expect(run()).toMatchObject({ state: 'executing', status: 'executing', attempt: 4, lease_owner: LEASE_A, lease_expires_at: at(120_000) });
    // Nothing after the refused write was treated as committed.
    expect(events()).not.toContain('followup_scheduled');
    expect(request()).toMatchObject({ status: 'executing' });
    // What landed before it stands (the first step's completion is the tool's
    // own, idempotent effect), and the second step was never started.
    const steps = db.table('ai_plan_steps');
    expect(steps.find((s) => s.id === STEP_2)).toMatchObject({ status: 'queued', started_at: null });
  });

  it('a run with no lease is written the way it always was — the fence is a property of a claim', async () => {
    // The paths that drive the graph without a lease (and the suites that do)
    // keep the id-and-family write.
    seed({ state: 'ready', status: 'approved', attempt: 0, lease_owner: null, lease_expires_at: null });
    const result = await runGraphWith(worker(async () => DONE), RUN, { budgetMs: 60_000 });
    expect(result.status).toBe('completed');
    expect(run()).toMatchObject({ state: 'completed', lease_owner: null });
  });

  it('a run already at the ceiling when this shipped is dead-lettered by the recovery arm before any claim, satisfied steps or not (review 4173803806)', () => {
    // Pre-#901 accounting charged every claim, so a run that completed work
    // across healthy slices and then died once at its fifth claim sits here:
    // `executing`, lease run out, attempt 5 of 5, three steps done.
    seed(
      { attempt: CEILING, lease_owner: LEASE_A, lease_expires_at: at(-60_000) },
      [
        step({ id: '00000000-0000-4000-8000-00000000cc61', sequence: 0, status: 'completed', completed_at: at(-50 * 60_000) }),
        step({ id: '00000000-0000-4000-8000-00000000cc62', sequence: 1, status: 'completed', completed_at: at(-40 * 60_000) }),
        step({ id: '00000000-0000-4000-8000-00000000cc63', sequence: 2, status: 'completed', completed_at: at(-30 * 60_000) }),
        step({ id: '00000000-0000-4000-8000-00000000cc64', sequence: 3, status: 'queued', dependency_ids: ['00000000-0000-4000-8000-00000000cc63'] }),
      ],
    );

    // The recovery arm runs before the claiming pass, and its test is the
    // counter alone. Nothing is claimed, so no slice runs, so the hand-back
    // in `runGraphWith` is never reached for this row.
    expect(claimAiRuns({ p_limit: 10 }, db)).toEqual([]);
    expect(run()).toMatchObject({ state: 'failed', status: 'failed', error: ABANDONED, attempt: CEILING, lease_owner: null });
    // Its three finished steps are still finished — what it did is kept; what
    // is lost is the automatic way back. That way back is a person's, in the
    // change that follows this one.
    expect(db.table('ai_plan_steps').filter((s) => s.status === 'completed')).toHaveLength(3);
  });
});
