// A person's re-entry that loaded the run before someone else moved it cannot
// re-arm the run over that move (review on #917, 5973301004).
//
// Four writes put a run back in the queue because a member of the family
// asked: an approval decision folding into its run (lib/services/approvals,
// foldIntoRun), resume, re-run a step and edit a step (lib/ai/runs/controls).
// Each loads the run, decides from that snapshot, and writes `ready`, a fresh
// budget (#917, freshBudget) and a cleared lease. They wrote through the plain
// `updateRun`, which matches on id and family alone — so two of them holding
// the same snapshot both landed. The case the review named: two final
// approval decisions fold into one run together. The first puts the run in the
// queue and a worker claims it (`executing`, attempt charged, a live lease).
// The second, still holding the snapshot that said `awaiting_approval`, then
// wrote `ready`, zeroed the attempt and cleared the worker's live lease while
// the worker was executing — the lease fence #901 gave the WORKER does not
// reach a write a person's control makes.
//
// Every one of the four now goes through `updateRunAsObserved` (store.ts): the
// write is conditioned on the state, attempt and lease the snapshot showed,
// so once anything has moved it matches nothing, and the caller leaves the run
// where the other party put it (the fold has nothing left to do and sends no
// kick; the controls say so).
//
// The race is deterministic here: the client hands the re-entry its snapshot
// of the run and, before the re-entry can use it, lets the other party act —
// the other decision folds in and a worker claims, through the real `decide`
// and the real `claimRun` over the same in-memory tables. Then the stale
// re-entry proceeds. Evidence is the in-memory client; no PostgreSQL race is
// claimed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

const seam = vi.hoisted(() => ({ client: null as unknown, kicked: [] as string[] }));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => {
    if (!seam.client) throw new Error('the test hands the services their client');
    return seam.client;
  },
  createServer: async () => { throw new Error('the test hands the services their client'); },
}));
vi.mock('@/lib/ai/runs/continue', () => ({
  kickRun: (runId: string) => { seam.kicked.push(runId); },
  continueRun: async () => ({ status: 'unavailable', completed: 0, failed: 0, pending: 0, awaitingApproval: 0, claimed: false }),
}));
vi.mock('@/lib/ai/tools/execute', () => ({
  executeTool: async () => { throw new Error('a plan_steps decision releases the step; it never runs the tool itself'); },
}));

const { decide } = await import('@/lib/services/approvals');
const { rerunStep, resumeRun } = await import('@/lib/ai/runs/controls');
const { claimRun } = await import('@/lib/ai/runs/store');

const FAMILY = '00000000-0000-4000-8000-00000000fa07';
const USER_A = '00000000-0000-4000-8000-0000000000a7';
const USER_B = '00000000-0000-4000-8000-0000000000b7';
const PARENT_A = '00000000-0000-4000-8000-00000000ae07';
const PARENT_B = '00000000-0000-4000-8000-00000000ae08';
const REQUEST = '00000000-0000-4000-8000-00000000cc71';
const PLAN = '00000000-0000-4000-8000-00000000cc72';
const RUN = '00000000-0000-4000-8000-00000000cc73';
const STEP_1 = '00000000-0000-4000-8000-00000000cc74';
const STEP_2 = '00000000-0000-4000-8000-00000000cc75';
const APPROVAL_1 = '00000000-0000-4000-8000-00000000cc76';
const APPROVAL_2 = '00000000-0000-4000-8000-00000000cc77';
const NOW = new Date('2026-10-03T12:00:00.000Z');

let db: InMemorySupabase;
const raw = () => db as unknown as SupabaseClient<Database>;
const run = () => db.table('family_automation_runs').find((r) => r.id === RUN) as Row;
const stepRow = (id: string) => db.table('ai_plan_steps').find((s) => s.id === id) as Row;
const approvalRow = (id: string) => db.table('approval_requests').find((a) => a.id === id) as Row;

const scopeFor = (client: SupabaseClient<Database>, who: 'A' | 'B'): ServiceScope => ({
  db: client, familyId: FAMILY, userId: who === 'A' ? USER_A : USER_B, memberId: who === 'A' ? PARENT_A : PARENT_B,
  role: 'parent', actorKind: 'member', tz: 'UTC',
} as unknown as ServiceScope);

function approval(id: string, stepId: string): Row {
  return {
    id, family_id: FAMILY, domain: 'calendar', capability: 'automate', requested_by_kind: 'ai', requested_by_member_id: PARENT_A,
    agent: 'concierge', title: `Step ${stepId.slice(-2)}`, summary: null,
    payload: { kind: 'plan_steps', run_id: RUN, step_ids: [stepId] }, payload_kind: 'plan_steps',
    amount_cents: null, confidence: 0.9, policy_id: null, reasoning: 'risk tier', approval_model: 'single', required_approvals: 1,
    approvals: [], status: 'pending', priority: 'normal', decided_by: null, decided_at: null, expires_at: '2099-01-01T00:00:00Z',
    executed_at: null, execution_result: null, request_id: REQUEST, run_id: RUN, plan_step_id: stepId, plan_step_ids: [stepId],
    consequences: [], evidence: null, edited_payload: null, reviewed_by: null, review_note: null,
    created_at: '2026-10-03T11:00:00.000Z', updated_at: '2026-10-03T11:00:00.000Z',
  };
}

function step(id: string, sequence: number, over: Row = {}): Row {
  return {
    id, family_id: FAMILY, plan_id: PLAN, sequence, step_type: 'act', tool_name: 'calendar.createEvent', description: `Step ${sequence}`,
    input_json: { title: 'Dentist' }, dependency_ids: [], condition: null, status: 'awaiting_approval', approval_required: true,
    approval_id: null, risk_level: 'medium', retry_count: 0, max_retries: 2, result_json: null, error: null, started_at: null,
    completed_at: null, ...over,
  };
}

/** One run of one plan, with whatever the case needs on the run row and its steps. */
function seed(runOver: Row, steps: Row[]) {
  db.seed('families', [{ id: FAMILY, name: 'Fixture', timezone: 'UTC', created_by: USER_A }]);
  db.seed('family_members', [
    { id: PARENT_A, family_id: FAMILY, user_id: USER_A, display_name: 'A', role: 'parent', is_active: true },
    { id: PARENT_B, family_id: FAMILY, user_id: USER_B, display_name: 'B', role: 'parent', is_active: true },
  ]);
  db.seed('ai_requests', [{ id: REQUEST, family_id: FAMILY, requested_by: USER_A, requested_by_member_id: PARENT_A, kind: 'concierge', request_text: 'Plan the week', status: 'awaiting_approval', error: null }]);
  db.seed('ai_plans', [{ id: PLAN, family_id: FAMILY, request_id: REQUEST, version: 1, status: 'approved', risk_level: 'medium' }]);
  db.seed('ai_plan_steps', steps);
  db.seed('family_automation_runs', [{
    id: RUN, family_id: FAMILY, run_type: 'concierge_plan', plan_id: PLAN, request_id: REQUEST, requested_by_member_id: PARENT_A,
    state: 'awaiting_approval', status: 'pending', progress: {}, attempt: 2, max_attempts: 5, lease_owner: null, lease_expires_at: null,
    cancel_requested_at: null, paused_at: null, started_at: '2026-10-03T11:00:00.000Z', completed_at: null, error: null, summary: null,
    run_after: '2026-10-03T11:30:00.000Z', created_by: USER_A, ...runOver,
  }]);
}

/**
 * The in-memory client, with one difference: the first time a run row is read
 * with `.maybeSingle()`, the snapshot is taken — and then, before the caller
 * can act on it, `meanwhile` runs. Everything the caller does after that is
 * done holding a snapshot the world has moved on from. Disarmed before
 * `meanwhile` runs, so the other party's own reads pass straight through.
 */
function staleAfterFirstRunRead(meanwhile: () => Promise<void>): SupabaseClient<Database> {
  let armed = true;
  const proxy = new Proxy(db, {
    get(target, prop) {
      if (prop === 'from') {
        return (table: string) => {
          const builder = target.from(table) as unknown as { maybeSingle: () => Promise<unknown> };
          if (table !== 'family_automation_runs') return builder;
          const read = builder.maybeSingle.bind(builder);
          builder.maybeSingle = async () => {
            const snapshot = await read();
            if (armed) { armed = false; await meanwhile(); }
            return snapshot;
          };
          return builder;
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return proxy as unknown as SupabaseClient<Database>;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  db = createInMemorySupabase({ userId: USER_A });
  seam.client = raw();
  seam.kicked = [];
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('two final approval folds and a claim', () => {
  const twoGatedSteps = () => [
    step(STEP_1, 0, { approval_id: APPROVAL_1 }),
    step(STEP_2, 1, { approval_id: APPROVAL_2 }),
  ];

  it('the second fold, holding the snapshot from before the first, does not write ready, a zero attempt or a cleared lease over the worker that claimed the run', async () => {
    seed({}, twoGatedSteps());
    db.seed('approval_requests', [approval(APPROVAL_1, STEP_1), approval(APPROVAL_2, STEP_2)]);

    let worker: string | null = null;
    // B's decision reads the run (awaiting_approval, attempt 2, no lease) —
    // and before it can act, A's decision folds in and the kick's claim lands.
    const stale = staleAfterFirstRunRead(async () => {
      const first = await decide(scopeFor(raw(), 'A'), APPROVAL_1, 'approved');
      expect(first).toMatchObject({ ok: true, data: { status: 'approved', resumedRunId: RUN } });
      expect(run()).toMatchObject({ state: 'ready', attempt: 0, lease_owner: null });
      const claim = await claimRun(raw(), RUN, 120);
      expect(claim).toMatchObject({ ok: true, data: { claimed: true } });
      worker = run().lease_owner as string;
      expect(run()).toMatchObject({ state: 'executing', attempt: 1 });
    });
    seam.client = stale;

    const second = await decide(scopeFor(stale, 'B'), APPROVAL_2, 'approved');

    // B's decision is recorded and its step is released ...
    expect(second).toMatchObject({ ok: true, data: { status: 'approved', executed: true, resumedRunId: null } });
    expect(approvalRow(APPROVAL_2).status).toBe('approved');
    expect(stepRow(STEP_2).status).toBe('ready');
    // ... and the run is exactly as the worker left it: its claim, its attempt,
    // its lease. Nothing was re-armed over it, and B's fold sent no kick.
    expect(worker).toBeTruthy();
    expect(run()).toMatchObject({ state: 'executing', attempt: 1, lease_owner: worker });
    expect(run().lease_expires_at).toBe(new Date(NOW.getTime() + 120_000).toISOString());
    expect(seam.kicked, 'one kick: the fold that actually put the run in the queue').toEqual([RUN]);
    // The step B released is in the graph the worker reloads every pass.
    expect(stepRow(STEP_1).status).toBe('ready');
  });

  it('non-vacuity: a fold whose snapshot is still true puts the run in the queue with a fresh budget and kicks it', async () => {
    seed({ attempt: 5 }, [step(STEP_1, 0, { approval_id: APPROVAL_1 })]);
    db.seed('approval_requests', [approval(APPROVAL_1, STEP_1)]);

    const only = await decide(scopeFor(raw(), 'A'), APPROVAL_1, 'approved');
    expect(only).toMatchObject({ ok: true, data: { status: 'approved', resumedRunId: RUN } });
    expect(run()).toMatchObject({ state: 'ready', attempt: 0, lease_owner: null, error: null });
    expect(seam.kicked).toEqual([RUN]);
  });
});

describe('the controls, from a snapshot the world moved on from', () => {
  it('re-run a step: a worker claimed the run between the read and the write — the claim stands, the person is told, the re-queued step is the worker\'s to pick up', async () => {
    seed({ state: 'ready', status: 'approved', attempt: 1 }, [step(STEP_1, 0, { status: 'failed', approval_required: false, error: 'Timed out.' })]);
    let worker: string | null = null;
    const stale = staleAfterFirstRunRead(async () => {
      const claim = await claimRun(raw(), RUN, 120);
      expect(claim).toMatchObject({ ok: true, data: { claimed: true } });
      worker = run().lease_owner as string;
    });

    const asked = await rerunStep(scopeFor(stale, 'A'), RUN, STEP_1, { db: stale });

    expect(asked.ok).toBe(false);
    if (!asked.ok) expect(asked.error).toContain('changed while this was being asked');
    expect(run()).toMatchObject({ state: 'executing', attempt: 2, lease_owner: worker });
    // The step itself was re-queued before the run write; the executing worker
    // reloads its steps every pass, so the ask is honoured by the claim that
    // won, not by overwriting it.
    expect(stepRow(STEP_1).status).toBe('queued');
  });

  it('re-run a step on a run that is executing: the slice parks and a NEW claim starts between the read and the write — same state, different attempt and lease — and the write does not land', async () => {
    // Why the compare is on state, attempt AND lease, not the state alone: the
    // run is `executing` before and after, under two different workers.
    const W1 = '00000000-0000-4000-8000-00000000d001';
    seed({ state: 'executing', status: 'executing', attempt: 1, lease_owner: W1, lease_expires_at: new Date(NOW.getTime() + 120_000).toISOString() },
      [step(STEP_1, 0, { status: 'failed', approval_required: false, error: 'Timed out.' }), step(STEP_2, 1, { status: 'queued', approval_required: false })]);
    let worker: string | null = null;
    const stale = staleAfterFirstRunRead(async () => {
      // W1's slice parks the run (ready, lease cleared), and the next claim takes it.
      Object.assign(run(), { state: 'ready', status: 'approved', lease_owner: null, lease_expires_at: null, run_after: NOW.toISOString() });
      const claim = await claimRun(raw(), RUN, 120);
      expect(claim).toMatchObject({ ok: true, data: { claimed: true } });
      worker = run().lease_owner as string;
      expect(worker).not.toBe(W1);
      expect(run()).toMatchObject({ state: 'executing', attempt: 2 });
    });

    const asked = await rerunStep(scopeFor(stale, 'A'), RUN, STEP_1, { db: stale });

    expect(asked.ok).toBe(false);
    expect(run()).toMatchObject({ state: 'executing', attempt: 2, lease_owner: worker });
    expect(run().lease_expires_at).toBe(new Date(NOW.getTime() + 120_000).toISOString());
  });

  it('resume: another tab resumed the run and a worker claimed it — the second resume finds it is not paused and leaves the claim alone', async () => {
    seed({ state: 'paused', status: 'paused', attempt: 5, paused_at: '2026-10-03T11:40:00.000Z' }, [step(STEP_1, 0, { status: 'queued', approval_required: false })]);
    let worker: string | null = null;
    const stale = staleAfterFirstRunRead(async () => {
      const other = await resumeRun(scopeFor(raw(), 'B'), RUN, { db: raw() });
      expect(other).toMatchObject({ ok: true, data: { state: 'ready' } });
      const claim = await claimRun(raw(), RUN, 120);
      expect(claim).toMatchObject({ ok: true, data: { claimed: true } });
      worker = run().lease_owner as string;
    });

    const mine = await resumeRun(scopeFor(stale, 'A'), RUN, { db: stale });

    expect(mine).toMatchObject({ ok: false, error: 'That run is not paused.' });
    expect(run()).toMatchObject({ state: 'executing', attempt: 1, lease_owner: worker, paused_at: null });
  });

  it('non-vacuity: a control whose snapshot is still true lands', async () => {
    seed({ state: 'paused', status: 'paused', attempt: 5, paused_at: '2026-10-03T11:40:00.000Z' }, [step(STEP_1, 0, { status: 'queued', approval_required: false })]);
    const resumed = await resumeRun(scopeFor(raw(), 'A'), RUN, { db: raw() });
    expect(resumed).toMatchObject({ ok: true, data: { state: 'ready' } });
    expect(run()).toMatchObject({ state: 'ready', attempt: 0, paused_at: null });
  });
});
