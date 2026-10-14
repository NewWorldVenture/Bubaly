// A run in flight belongs to the worker running it, and to the plan that
// worker read.
//
// N1 — Editing a step while its run was executing: `editStepInput` checked
// only for `cancelled`, wrote plan version N+1 and pointed the run at it, while
// the worker kept scheduling from the version-N steps it had already loaded. It
// ran the old step with the old words, then (the edit having requeued a copy)
// the new one with the new words — two to-dos the ledger cannot fold, their
// arguments differ. Now the edit is refused while a worker holds the run, the
// repoint is a compare-and-set on what was read, and a worker whose run was
// pointed at another version reloads it before choosing its next batch.
//
// N10 — Pause then Resume while a batch was running: pause cleared the live
// lease and resume set `ready`, so the resume's kick claimed the run for a
// second worker while the first was still running steps; the first never
// noticed, and heartbeated with the second's token. Now pause leaves a live
// lease with its worker, and a worker whose lease changed hands stops.
//
// N11 — An edit requeued every step it did not carry as finished, with no
// approval: a step waiting on a card filed a second card, one a parent already
// approved was asked again, one they declined was queued again, and the old
// cards stayed pending. Now everything outside the edit is carried as it
// stands, and the edited step's old card is withdrawn.
//
// N11, paused — Editing a step of a paused run set it `ready` and left
// `paused_at` on it. The kick claimed it, the executor saw `paused_at` and
// stopped at once with the run still `executing`, Resume answered "not
// paused", and the recovery pass re-claimed it every tick until it was
// dead-lettered — Pause, fix a step, Resume, the ordinary way to correct
// Bubaly, lost the run. Now a paused run stays paused through an edit.
//
// N11, re-run on a paused run — "Try again" on a failed step of a paused run
// did the same through another control: `rerunStep` set the run `ready` with
// `paused_at` still on it, the control kicked it, the executor stopped at once
// with the run `executing`, Resume answered "not paused", and the recovery
// pass re-claimed it every tick until it was dead-lettered. Now the re-run
// requeues the step and leaves the run paused, the control kicks only a run
// left `ready`, and a re-run is refused while a worker holds the run.
//
// N10, the lease handoff edges — one failed heartbeat ended the slice as if
// the lease had been lost, and a Resume that landed while the worker was
// parking on a pause found the lease still held, so its kick claimed nothing
// and the run sat `ready` until the next ai-runs tick. Now a heartbeat error
// is asked once more, and the worker that parked looks once more for a run
// resumed under it.
//
// Driven through the real controls, the real executor port, `executeTool`, its
// ledger and the tasks service, over the in-memory database.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

const hoisted = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => hoisted.db, createServer: async () => hoisted.db }));

const { createExecutorPort, runGraphWith } = await import('@/lib/ai/runs/executor');
const { editStepInput, pauseRun, resumeRun } = await import('@/lib/ai/runs/controls');
const { claimRun } = await import('@/lib/ai/runs/store');
const { applyRunControl } = await import('@/lib/ai/runs/intake');
const { continueRun } = await import('@/lib/ai/runs/continue');

const FAMILY = '00000000-0000-4000-8000-0000000f1e01';
const PARENT = { member: '00000000-0000-4000-8000-0000000f1e11', user: '00000000-0000-4000-8000-0000000f1e21' };
const REQUEST = '00000000-0000-4000-8000-0000000f1e31';
const PLAN = '00000000-0000-4000-8000-0000000f1e32';
const RUN = '00000000-0000-4000-8000-0000000f1e33';
const LIVE_LEASE = '2099-01-01T00:00:00.000Z';

let db: InMemorySupabase;
const client = () => db as unknown as SupabaseClient<Database>;
const parent = (): ServiceScope => ({
  db: client(), familyId: FAMILY, userId: PARENT.user, memberId: PARENT.member, role: 'parent', actorKind: 'member', tz: 'America/New_York',
});

function todo(id: string, plan: string, title: string, over: Row = {}): Row {
  return {
    id, family_id: FAMILY, plan_id: plan, sequence: Number(id.replace(/\D/g, '').slice(-1) || 0), step_type: 'act', tool_name: 'tasks.createTodo',
    description: title, input_json: { title }, dependency_ids: [], condition: null, status: 'queued', approval_required: false,
    approval_id: null, risk_level: 'low', retry_count: 0, max_retries: 0, result_json: null, error: null, ...over,
  };
}

beforeEach(() => {
  db = createInMemorySupabase({
    uniques: { ai_tool_calls: [['family_id', 'idempotency_key']] },
    defaults: {
      ai_tool_calls: { state: 'reserved', attempt: 1, outputs: null, error: null, finished_at: null },
      todo_items: { is_done: false, priority: 'medium', tags: [], sort_order: 0, completed_at: null, due_date: null, notes: null, assigned_to_id: null },
      todo_lists: { is_archived: false },
      approval_requests: { approvals: [], edited_payload: null, plan_step_ids: [], expires_at: '2099-01-01T00:00:00Z' },
    },
  });
  hoisted.db = db;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  db.seed('families', [{ id: FAMILY, name: 'The Riveras', timezone: 'America/New_York' }]);
  db.seed('family_members', [{ id: PARENT.member, family_id: FAMILY, user_id: PARENT.user, role: 'parent', is_active: true, display_name: 'Dana' }]);
  db.seed('family_ai_settings', [{ family_id: FAMILY, enabled: true, behavior: 'execute' }]);
  db.seed('ai_requests', [{ id: REQUEST, family_id: FAMILY, requested_by: PARENT.user, requested_by_member_id: PARENT.member, kind: 'concierge', request_text: 'Get ready for Saturday', status: 'executing' }]);
  db.seed('ai_plans', [{ id: PLAN, family_id: FAMILY, request_id: REQUEST, version: 1, status: 'approved', risk_level: 'low' }]);
});

function seedRun(over: Row = {}): void {
  db.seed('family_automation_runs', [{
    id: RUN, family_id: FAMILY, plan_id: PLAN, request_id: REQUEST, run_type: 'concierge', state: 'executing', status: 'approved',
    requested_by_member_id: PARENT.member, attempt: 1, max_attempts: 5, lease_owner: 'worker-1', lease_expires_at: LIVE_LEASE,
    run_after: '2026-01-01T00:00:00.000Z', cancel_requested_at: null, paused_at: null, progress: {}, created_by: PARENT.user, ...over,
  }]);
}

const run = () => db.table('family_automation_runs').find((r) => r.id === RUN) as Row;
const titles = () => db.table('todo_items').filter((t) => t.family_id === FAMILY).map((t) => t.title).sort();

describe('N1: an edit and the worker running the run', () => {
  it('refuses to edit a step while a worker holds the run, and changes nothing', async () => {
    db.seed('ai_plan_steps', [todo('step-1', PLAN, 'Pack the soccer kit'), todo('step-2', PLAN, 'Buy snacks', { dependency_ids: ['step-1'] })]);
    seedRun();

    const result = await editStepInput(parent(), RUN, 'step-2', { title: 'Buy oranges' }, { db: client() });

    expect(result).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(run()).toMatchObject({ plan_id: PLAN, state: 'executing', lease_owner: 'worker-1' });
    expect(db.table('ai_plans')).toHaveLength(1);
    expect(db.table('ai_plan_steps')).toHaveLength(2);
  });

  it('does not point the run at the edit when a worker claims it between the read and the write', async () => {
    db.seed('ai_plan_steps', [todo('step-1', PLAN, 'Pack the soccer kit', { status: 'failed' })]);
    seedRun({ state: 'blocked', lease_owner: null, lease_expires_at: null });
    // The claim lands while the edit is saving its plan version.
    const steps = db.table('ai_plan_steps');
    const push = steps.push.bind(steps);
    steps.push = (...rows: Row[]) => {
      if (rows.some((r) => r.plan_id !== PLAN)) Object.assign(run(), { state: 'executing', lease_owner: 'worker-2', lease_expires_at: LIVE_LEASE });
      return push(...rows);
    };

    const result = await editStepInput(parent(), RUN, 'step-1', { title: 'Pack the shin guards' }, { db: client() });

    expect(result).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(run()).toMatchObject({ plan_id: PLAN, state: 'executing', lease_owner: 'worker-2' });
  });

  it('a worker whose run is pointed at another plan version runs that version, not the one it read', async () => {
    db.seed('ai_plan_steps', [todo('step-1', PLAN, 'Pack the soccer kit'), todo('step-2', PLAN, 'Buy snacks', { dependency_ids: ['step-1'] })]);
    seedRun();
    const PLAN_2 = '00000000-0000-4000-8000-0000000f1e42';
    const port = createExecutorPort(client());
    const runTool = port.runTool.bind(port);
    let repointed = false;
    port.runTool = async (...args) => {
      const outcome = await runTool(...args);
      if (!repointed) {
        // Version 2 lands while the first batch is still running: step 1 done,
        // step 2 reworded.
        repointed = true;
        db.seed('ai_plans', [{ id: PLAN_2, family_id: FAMILY, request_id: REQUEST, version: 2, status: 'approved', risk_level: 'low' }]);
        db.seed('ai_plan_steps', [
          todo('step-21', PLAN_2, 'Pack the soccer kit', { status: 'completed', result_json: { summary: 'done' } }),
          todo('step-22', PLAN_2, 'Buy oranges', { dependency_ids: ['step-21'] }),
        ]);
        run().plan_id = PLAN_2;
      }
      return outcome;
    };

    const result = await runGraphWith(port, RUN, { budgetMs: 60_000 });

    expect(result.status).toBe('completed');
    // The old wording never ran: one to-do per thing asked for.
    expect(titles()).toEqual(['Buy oranges', 'Pack the soccer kit']);
    expect(run()).toMatchObject({ plan_id: PLAN_2, state: 'completed' });
    expect(db.table('ai_plan_steps').find((s) => s.id === 'step-2')?.status).toBe('queued');
  });
});

describe('N10: pause and resume while a batch is running', () => {
  it('leaves the run with the worker running it, so the resume does not hand it to a second worker', async () => {
    db.seed('ai_plan_steps', [todo('step-1', PLAN, 'Pack the soccer kit'), todo('step-2', PLAN, 'Buy snacks', { dependency_ids: ['step-1'] })]);
    seedRun();
    const port = createExecutorPort(client());
    const runTool = port.runTool.bind(port);
    let second: Awaited<ReturnType<typeof claimRun>> | null = null;
    port.runTool = async (...args) => {
      if (!second) {
        expect((await pauseRun(parent(), RUN, { db: client() })).ok).toBe(true);
        expect((await resumeRun(parent(), RUN, { db: client() })).ok).toBe(true);
        // What the resume's kick does: try to lease the run for a new worker.
        second = await claimRun(client(), RUN);
      }
      return runTool(...args);
    };

    const result = await runGraphWith(port, RUN, { budgetMs: 60_000 });

    expect(second).toMatchObject({ ok: true, data: { claimed: false } });
    expect(result.status).toBe('completed');
    expect(titles()).toEqual(['Buy snacks', 'Pack the soccer kit']);
    expect(run()).toMatchObject({ state: 'completed', lease_owner: null });
  });

  it('a worker whose lease was taken over stops, and neither runs nor finalizes anything more', async () => {
    db.seed('ai_plan_steps', [todo('step-1', PLAN, 'Pack the soccer kit'), todo('step-2', PLAN, 'Buy snacks', { dependency_ids: ['step-1'] })]);
    seedRun();
    const port = createExecutorPort(client());
    const runTool = port.runTool.bind(port);
    let taken = false;
    port.runTool = async (...args) => {
      const outcome = await runTool(...args);
      if (!taken) { taken = true; Object.assign(run(), { lease_owner: 'worker-2', lease_expires_at: LIVE_LEASE }); }
      return outcome;
    };

    const result = await runGraphWith(port, RUN, { budgetMs: 60_000 });

    expect(result.status).toBe('lease_lost');
    expect(titles()).toEqual(['Pack the soccer kit']);
    expect(db.table('ai_plan_steps').find((s) => s.id === 'step-2')?.status).toBe('queued');
    // The second worker's lease and state are left exactly as it set them.
    expect(run()).toMatchObject({ state: 'executing', lease_owner: 'worker-2', lease_expires_at: LIVE_LEASE });
  });

  it('a worker that sees the pause lets its lease go, so the resume is picked up at once', async () => {
    db.seed('ai_plan_steps', [todo('step-1', PLAN, 'Pack the soccer kit'), todo('step-2', PLAN, 'Buy snacks', { dependency_ids: ['step-1'] })]);
    seedRun();
    const port = createExecutorPort(client());
    const runTool = port.runTool.bind(port);
    let paused = false;
    port.runTool = async (...args) => {
      const outcome = await runTool(...args);
      if (!paused) { paused = true; expect((await pauseRun(parent(), RUN, { db: client() })).ok).toBe(true); }
      return outcome;
    };

    expect((await runGraphWith(port, RUN, { budgetMs: 60_000 })).status).toBe('paused');
    expect(run()).toMatchObject({ state: 'paused', lease_owner: null });
    expect((await resumeRun(parent(), RUN, { db: client() })).ok).toBe(true);
    expect(await claimRun(client(), RUN)).toMatchObject({ ok: true, data: { claimed: true } });
  });
});

describe('N11: an edit carries every step it does not change', () => {
  function seedDecisions(): void {
    db.seed('approval_requests', [
      { id: 'appr-held', family_id: FAMILY, run_id: RUN, plan_step_id: 'step-1', status: 'pending', domain: 'tasks', capability: 'automate', payload: { kind: 'plan_steps', step_ids: ['step-1'] }, payload_kind: 'plan_steps', plan_step_ids: ['step-1'] },
      { id: 'appr-yes', family_id: FAMILY, run_id: RUN, plan_step_id: 'step-2', status: 'approved', domain: 'tasks', capability: 'automate', payload: { kind: 'plan_steps', step_ids: ['step-2'] }, payload_kind: 'plan_steps', plan_step_ids: ['step-2'] },
      { id: 'appr-no', family_id: FAMILY, run_id: RUN, plan_step_id: 'step-3', status: 'rejected', domain: 'tasks', capability: 'automate', payload: { kind: 'plan_steps', step_ids: ['step-3'] }, payload_kind: 'plan_steps', plan_step_ids: ['step-3'] },
    ]);
    db.seed('ai_plan_steps', [
      todo('step-1', PLAN, 'Call the coach', { status: 'awaiting_approval', approval_required: true, approval_id: 'appr-held' }),
      todo('step-2', PLAN, 'Book the field', { status: 'ready', approval_required: true, approval_id: 'appr-yes' }),
      todo('step-3', PLAN, 'Order jerseys', { status: 'cancelled', approval_required: true, approval_id: 'appr-no', error: 'The request was rejected.' }),
      todo('step-4', PLAN, 'Buy snacks'),
    ]);
    seedRun({ state: 'awaiting_approval', status: 'pending', lease_owner: null, lease_expires_at: null });
  }
  const current = () => db.table('ai_plan_steps').filter((s) => s.plan_id === run().plan_id);
  const byTitle = (title: string) => current().find((s) => s.description === title) as Row;

  it('keeps a held step on its card, an approved one approved and a declined one declined', async () => {
    seedDecisions();

    const result = await editStepInput(parent(), RUN, 'step-4', { title: 'Buy oranges' }, { db: client() });

    expect(result).toMatchObject({ ok: true, data: { requeuedSteps: 1 } });
    expect(run().plan_id).not.toBe(PLAN);
    expect(byTitle('Call the coach')).toMatchObject({ status: 'awaiting_approval', approval_id: 'appr-held' });
    expect(byTitle('Book the field')).toMatchObject({ status: 'ready', approval_id: 'appr-yes' });
    expect(byTitle('Order jerseys')).toMatchObject({ status: 'cancelled', approval_id: 'appr-no', error: 'The request was rejected.' });
    expect(byTitle('Buy snacks')).toMatchObject({ status: 'queued', input_json: { title: 'Buy oranges' }, approval_id: null });
    // Nothing was withdrawn: none of those cards asked about the edited step.
    expect(db.table('approval_requests').map((a) => a.status).sort()).toEqual(['approved', 'pending', 'rejected']);
  });

  it('the next slice files no second card for the held step', async () => {
    seedDecisions();
    // Only the held step and the edited one, so the slice has nothing else to decide.
    db.replace('ai_plan_steps', db.table('ai_plan_steps').filter((s) => s.id === 'step-1' || s.id === 'step-4'));
    db.replace('approval_requests', db.table('approval_requests').filter((a) => a.id === 'appr-held'));
    expect((await editStepInput(parent(), RUN, 'step-4', { title: 'Buy oranges' }, { db: client() })).ok).toBe(true);
    Object.assign(run(), { lease_owner: 'worker-3', lease_expires_at: LIVE_LEASE });

    const result = await runGraphWith(createExecutorPort(client()), RUN, { budgetMs: 60_000 });

    expect(result.status).toBe('awaiting_approval');
    expect(titles()).toEqual(['Buy oranges']);
    expect(db.table('approval_requests')).toHaveLength(1);
    expect(byTitle('Call the coach')).toMatchObject({ status: 'awaiting_approval', approval_id: 'appr-held' });
  });

  it('withdraws the card the edited step was waiting on', async () => {
    seedDecisions();

    expect((await editStepInput(parent(), RUN, 'step-1', { title: 'Text the coach' }, { db: client() })).ok).toBe(true);

    expect(db.table('approval_requests').find((a) => a.id === 'appr-held')).toMatchObject({ status: 'cancelled', decided_by: PARENT.user });
    expect(byTitle('Call the coach')).toMatchObject({ status: 'queued', input_json: { title: 'Text the coach' }, approval_id: null });
    expect(db.table('approval_requests').find((a) => a.id === 'appr-yes')?.status).toBe('approved');
  });
});

describe('N11: an edit to a paused run', () => {
  it('keeps the run paused, and Resume then runs the edited step', async () => {
    db.seed('ai_plan_steps', [
      todo('step-1', PLAN, 'Pack the soccer kit', { status: 'completed', result_json: { summary: 'done' } }),
      todo('step-2', PLAN, 'Buy snacks', { dependency_ids: ['step-1'] }),
    ]);
    // Paused, and its worker parked and let go of the lease.
    seedRun({ state: 'paused', status: 'paused', paused_at: '2026-01-01T00:00:00.000Z', lease_owner: null, lease_expires_at: null });

    const edited = await editStepInput(parent(), RUN, 'step-2', { title: 'Buy oranges' }, { db: client() });

    expect(edited).toMatchObject({ ok: true, data: { requeuedSteps: 1, state: 'paused' } });
    expect(run()).toMatchObject({ state: 'paused', paused_at: '2026-01-01T00:00:00.000Z', lease_owner: null });
    expect(run().plan_id).not.toBe(PLAN);
    // Nothing takes a paused run: a kick now claims nothing.
    expect(await claimRun(client(), RUN)).toMatchObject({ ok: true, data: { claimed: false } });
    expect(run().state).toBe('paused');

    expect(await resumeRun(parent(), RUN, { db: client() })).toMatchObject({ ok: true, data: { state: 'ready' } });
    expect(run()).toMatchObject({ state: 'ready', paused_at: null });
    expect(await claimRun(client(), RUN)).toMatchObject({ ok: true, data: { claimed: true } });

    const result = await runGraphWith(createExecutorPort(client()), RUN, { budgetMs: 60_000 });

    expect(result.status).toBe('completed');
    // The edited words ran, once; the finished step was not repeated.
    expect(titles()).toEqual(['Buy oranges']);
    expect(run()).toMatchObject({ state: 'completed', lease_owner: null });
  });

  it('control: an edit to a run that is not paused queues it to run', async () => {
    db.seed('ai_plan_steps', [todo('step-1', PLAN, 'Pack the soccer kit', { status: 'failed', error: 'Timed out' })]);
    seedRun({ state: 'blocked', lease_owner: null, lease_expires_at: null });

    const edited = await editStepInput(parent(), RUN, 'step-1', { title: 'Pack the shin guards' }, { db: client() });

    expect(edited).toMatchObject({ ok: true, data: { state: 'ready' } });
    expect(run().state).toBe('ready');
  });
});

describe('N11: "Try again" on a paused run', () => {
  const PAUSED_AT = '2026-01-01T00:00:00.000Z';
  const kicks: string[] = [];
  const kick = (id: string) => { kicks.push(id); };
  beforeEach(() => { kicks.length = 0; });

  it('requeues the failed step and what it blocked, keeps the run paused, and Resume then runs them', async () => {
    // Pause was pressed while a slice ran, and a step in that batch failed.
    db.seed('ai_plan_steps', [
      todo('step-1', PLAN, 'Pack the soccer kit', { status: 'failed', error: 'Timed out' }),
      todo('step-2', PLAN, 'Buy snacks', { status: 'blocked', dependency_ids: ['step-1'], error: 'A step this one depends on did not finish.' }),
    ]);
    // The worker parked on the pause and let go of the lease.
    seedRun({ state: 'paused', status: 'paused', paused_at: PAUSED_AT, lease_owner: null, lease_expires_at: null });
    Object.assign(db.table('ai_requests')[0], { status: 'blocked' });

    const rerun = await applyRunControl(parent(), RUN, 'rerun', { stepId: 'step-1' }, { db: client(), kick });

    expect(rerun).toMatchObject({ ok: true, data: { action: 'rerun', state: 'queued' } });
    // Still paused, so nothing is kicked and nothing can claim it.
    expect(kicks).toEqual([]);
    expect(run()).toMatchObject({ state: 'paused', paused_at: PAUSED_AT, lease_owner: null });
    expect(db.table('ai_requests')[0].status).toBe('blocked');
    expect(db.table('ai_plan_steps').map((s) => s.status)).toEqual(['queued', 'queued']);
    expect(await claimRun(client(), RUN)).toMatchObject({ ok: true, data: { claimed: false } });

    expect(await resumeRun(parent(), RUN, { db: client() })).toMatchObject({ ok: true, data: { state: 'ready' } });
    expect(await claimRun(client(), RUN)).toMatchObject({ ok: true, data: { claimed: true } });
    const result = await runGraphWith(createExecutorPort(client()), RUN, { budgetMs: 60_000 });

    expect(result.status).toBe('completed');
    // The re-run step ran, and the one it had blocked after it.
    expect(titles()).toEqual(['Buy snacks', 'Pack the soccer kit']);
    expect(run()).toMatchObject({ state: 'completed', paused_at: null, lease_owner: null });
  });

  it('refuses while a worker holds the run, and changes nothing', async () => {
    db.seed('ai_plan_steps', [todo('step-1', PLAN, 'Pack the soccer kit', { status: 'failed', error: 'Timed out' }), todo('step-2', PLAN, 'Buy snacks')]);
    seedRun();

    const rerun = await applyRunControl(parent(), RUN, 'rerun', { stepId: 'step-1' }, { db: client(), kick });

    expect(rerun).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(kicks).toEqual([]);
    expect(run()).toMatchObject({ state: 'executing', lease_owner: 'worker-1', lease_expires_at: LIVE_LEASE });
    expect(db.table('ai_plan_steps').find((s) => s.id === 'step-1')).toMatchObject({ status: 'failed', error: 'Timed out' });
  });

  it('control: on a run that is not paused it queues the run and kicks it', async () => {
    db.seed('ai_plan_steps', [todo('step-1', PLAN, 'Pack the soccer kit', { status: 'failed', error: 'Timed out' })]);
    seedRun({ state: 'failed', status: 'failed', lease_owner: null, lease_expires_at: null });

    const rerun = await applyRunControl(parent(), RUN, 'rerun', { stepId: 'step-1' }, { db: client(), kick });

    expect(rerun).toMatchObject({ ok: true, data: { action: 'rerun', state: 'queued' } });
    expect(kicks).toEqual([RUN]);
    expect(run()).toMatchObject({ state: 'ready', lease_owner: null });
  });
});

describe('N10: the lease handoff edges', () => {
  /** The client, with the first heartbeat answering a dropped connection. */
  function droppingFirstHeartbeat(): { client: SupabaseClient<Database>; dropped: () => number } {
    let dropped = 0;
    const wrapped = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== 'from') return Reflect.get(target, prop, receiver);
        return (table: string) => {
          const builder = target.from(table);
          if (table !== 'family_automation_runs') return builder;
          const update = builder.update.bind(builder);
          return Object.assign(builder, {
            update: (patch: Row) => {
              const updating = update(patch);
              if (dropped > 0 || Object.keys(patch).join() !== 'lease_expires_at') return updating;
              dropped += 1;
              return Object.assign(updating, {
                maybeSingle: async () => ({
                  data: null, count: null, status: 503, statusText: 'Service Unavailable',
                  error: { code: '08006', message: 'connection reset', details: null, hint: null },
                }),
              });
            },
          });
        };
      },
    });
    return { client: wrapped as unknown as SupabaseClient<Database>, dropped: () => dropped };
  }

  it('one heartbeat that errors does not end the slice as a lost lease', async () => {
    db.seed('ai_plan_steps', [todo('step-1', PLAN, 'Pack the soccer kit'), todo('step-2', PLAN, 'Buy snacks', { dependency_ids: ['step-1'] })]);
    seedRun();
    const flaky = droppingFirstHeartbeat();

    const result = await runGraphWith(createExecutorPort(flaky.client), RUN, { budgetMs: 60_000 });

    expect(flaky.dropped()).toBe(1);
    expect(result.status).toBe('completed');
    expect(titles()).toEqual(['Buy snacks', 'Pack the soccer kit']);
    expect(run()).toMatchObject({ state: 'completed', lease_owner: null });
  });

  it('a Resume that lands while the worker parks on a pause is picked up, not left for the next tick', async () => {
    // The family has Ask Bubaly: `continueRun` executes only such a family's run.
    db.seed('subscriptions', [{ id: 'sub-riveras', family_id: FAMILY, plan: 'basic', status: 'active', current_period_end: '2099-01-01T00:00:00Z' }]);
    db.seed('ai_plan_steps', [todo('step-1', PLAN, 'Pack the soccer kit')]);
    seedRun({ state: 'ready', status: 'approved', attempt: 0, lease_owner: null, lease_expires_at: null });
    let resumeKick: ReturnType<typeof claimRun> | null = null;
    const events = db.table('ai_run_events');
    const push = events.push.bind(events);
    events.push = (...rows: Row[]) => {
      for (const row of rows) {
        // The slice has started: a parent presses Pause. `pauseRun` keeps the
        // worker's live lease, so this is its whole write.
        if (row.event_type === 'run_started') Object.assign(run(), { state: 'paused', status: 'paused', paused_at: new Date().toISOString() });
        // The worker has seen the pause and is about to let its lease go when
        // Resume lands, and Resume's kick tries to lease the run.
        if (row.event_type === 'paused' && !resumeKick) {
          Object.assign(run(), { state: 'ready', status: 'approved', paused_at: null, run_after: new Date().toISOString(), error: null });
          resumeKick = claimRun(client(), RUN);
        }
      }
      return push(...rows);
    };

    const result = await continueRun(RUN, { budgetMs: 60_000, db: client() });

    // Resume's own kick found the lease still held, and claimed nothing.
    expect(await resumeKick).toMatchObject({ ok: true, data: { claimed: false } });
    // The worker that parked picked the resumed run up.
    expect(result).toMatchObject({ claimed: true, status: 'completed' });
    expect(titles()).toEqual(['Pack the soccer kit']);
    expect(run()).toMatchObject({ state: 'completed', lease_owner: null });
  });
});
