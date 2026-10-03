// A run parked in the queue with no attempts left is abandoned, not claimed
// again (finalaudit Q40, second half).
//
// `attempt` is the run's abandonment budget. The recovery arm of `claim_ai_runs`
// dead-letters an `executing` run whose lease ran out once it reaches
// `max_attempts`; `claimRun` refuses to lease a run at that ceiling; and since
// the first half of Q40 the executor hands the budget back only when a slice
// made progress, so the counter is the number of slices in a row that
// completed nothing. The CLAIMING half of `claim_ai_runs` never read it: a run
// parked back to `ready` at the ceiling was claimed by every tick for ever,
// attempt 6, 7, 8 …, while every human-initiated path refused it — unreachable
// by people, unkillable by the worker. The dead-letter arm could not reach it
// either: it ran only for an expired lease on an `executing` row, and a parked
// run holds no lease.
//
// The migration found by `claimAiRunsMigration()` gives the recovery statement
// a second arm — a queued run at the ceiling is abandoned, with 0263's four-table
// reconcile — and the candidates the same `attempt < max_attempts` test the
// one-row path has. The function is SQL; its proof against the real thing is
// docs/audit/a-run-with-no-attempts-left-is-abandoned-check.sql. This file
// drives the real cron route and the real `claimRun` against the in-memory
// client with the predicate-for-predicate stand-in in tests/helpers, and pins
// the migration's shape.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { ABANDONED, claimAiRuns, claimAiRunsMigration } from './helpers/claim-ai-runs';

const seam = vi.hoisted(() => ({ service: vi.fn(), runGraph: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: seam.service }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/ai/runs/executor', () => ({ runGraph: seam.runGraph }));
vi.mock('@/lib/ai/planner/replan-port', () => ({ replanPortFor: () => null }));

import { GET as tick } from '@/app/api/cron/ai-runs/route';
import { claimRun } from '@/lib/ai/runs/store';

const ROOT = join(__dirname, '..');
const CRON_SECRET = 'cron-fixture-secret';
const FAMILY = '00000000-0000-4000-8000-00000000a0f2';
const RUN = '00000000-0000-4000-8000-00000000a0b1';
const OTHER = '00000000-0000-4000-8000-00000000a0b2';
const TICK_CADENCE_MS = 5 * 60_000;
/** The route's per-run slice. A slice that takes this long lets a tick hold three of them (3 × 25 s + the 12 s floor > 85 s). */
const PER_RUN_BUDGET_MS = 25_000;
const PARKED = { status: 'ready', completed: 0, failed: 0, pending: 1, awaitingApproval: 0 };

let db: InMemorySupabase;
let slices: number;
const client = () => db as unknown as SupabaseClient<Database>;
const rowOf = (id: string) => db.table('family_automation_runs').find((r) => r.id === id) as Row;
const run = () => rowOf(RUN);

function seedRun(overrides: Row = {}) {
  db.seed('family_automation_runs', [{
    id: RUN, family_id: FAMILY, run_type: 'concierge_plan', state: 'ready', status: 'approved', progress: {},
    attempt: 0, max_attempts: 5, lease_owner: null, lease_expires_at: null, cancel_requested_at: null, paused_at: null,
    started_at: null, completed_at: null, error: null, summary: null, plan_id: null, request_id: null,
    run_after: new Date(Date.now() - 60_000).toISOString(),
    ...overrides,
  }]);
}

/**
 * What `parkForContinuation` writes when the slice ran out of budget: back to
 * `ready`, due now, lease cleared — and `attempt` handed back ONLY when the
 * slice left more steps satisfied than it found (executor.ts, budgetReset).
 * Each slice spends its 25 s of the tick, so the route's own loop decides how
 * many slices a tick holds, exactly as in production.
 */
function parks(progressed: boolean | ((slice: number) => boolean), tookMs = PER_RUN_BUDGET_MS) {
  seam.runGraph.mockImplementation(async (runId: string) => {
    slices += 1;
    const did = typeof progressed === 'function' ? progressed(slices) : progressed;
    vi.setSystemTime(new Date(Date.now() + tookMs));
    Object.assign(rowOf(runId), {
      state: 'ready', status: 'approved', lease_owner: null, lease_expires_at: null,
      run_after: new Date().toISOString(), ...(did ? { attempt: 0 } : {}),
    });
    return PARKED;
  });
}

/** What the executor writes when the slice finishes the run. */
function completesTheRun() {
  seam.runGraph.mockImplementation(async (runId: string) => {
    slices += 1;
    vi.setSystemTime(new Date(Date.now() + PER_RUN_BUDGET_MS));
    Object.assign(rowOf(runId), { state: 'completed', status: 'executed', lease_owner: null, lease_expires_at: null, completed_at: new Date().toISOString() });
    return { status: 'completed', completed: 1, failed: 0, pending: 0, awaitingApproval: 0 };
  });
}

async function cronTick() {
  vi.setSystemTime(new Date(Date.now() + TICK_CADENCE_MS));
  const res = await tick(new NextRequest('https://fixture.invalid/api/cron/ai-runs', { headers: { authorization: `Bearer ${CRON_SECRET}` } }));
  return { status: res.status, body: await res.json() as { claimed: number; executed: number; returnedToQueue: number; results: Array<{ runId: string; status: string }> } };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-03T12:00:00.000Z'));
  vi.stubEnv('CRON_SECRET', CRON_SECRET);
  db = createInMemorySupabase({ rpc: { claim_ai_runs: (args, c) => claimAiRuns(args, c) } });
  db.seed('families', [{ id: FAMILY, name: 'Fixture', timezone: 'UTC' }]);
  slices = 0;
  seam.service.mockImplementation(() => db);
  seam.runGraph.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('the cron, when a parked run has no attempts left', () => {
  it('five slices that complete nothing spend the budget; the next claim abandons the run instead of taking it again', async () => {
    seedRun();
    parks(false);
    // A tick holds three slices. Each one parks the run `ready` and due, so the
    // same tick's next wave takes it again — that is how a run gets more than
    // one slice per tick — and each slice that completes nothing is charged.
    const first = await cronTick();
    expect(first.body.claimed).toBe(3);
    expect(run()).toMatchObject({ state: 'ready', attempt: 3, lease_owner: null, error: null });

    // Slices four and five, then the third wave finds a run at the ceiling in
    // the queue: abandoned, and the claim comes back empty.
    const second = await cronTick();
    expect(second.status).toBe(200);
    expect(second.body.claimed).toBe(2);
    expect(slices, 'exactly max_attempts slices, then no more').toBe(5);
    expect(run()).toMatchObject({ state: 'failed', status: 'failed', error: ABANDONED, attempt: 5, lease_owner: null, lease_expires_at: null });
    expect(run().completed_at).toBeTruthy();

    // And it stays abandoned: a later tick neither claims nor re-fails it.
    const third = await cronTick();
    expect(third.body.claimed).toBe(0);
    expect(slices).toBe(5);
    expect(run()).toMatchObject({ state: 'failed', attempt: 5 });
  });

  it('a slice that made progress hands the budget back, so the ceiling counts stalls in a row, not slices', async () => {
    // The two halves of Q40 together: four stalls, one slice that completed a
    // step, five more stalls — abandoned after the tenth slice, not the fifth.
    seedRun();
    parks((slice) => slice === 5);
    await cronTick();                       // slices 1-3: three stalls
    expect(run()).toMatchObject({ state: 'ready', attempt: 3 });
    await cronTick();                       // 4: stall; 5: progress, back to 0; 6: stall
    expect(run()).toMatchObject({ state: 'ready', attempt: 1 });
    await cronTick();                       // 7-9: stalls
    expect(run()).toMatchObject({ state: 'ready', attempt: 4, error: null });
    await cronTick();                       // 10: the fifth stall in a row; the next wave abandons
    expect(slices).toBe(10);
    expect(run()).toMatchObject({ state: 'failed', error: ABANDONED, attempt: 5 });
  });

  it('what the cron abandons, claimRun had already refused — the two claim paths agree, and the refusal now has a reason', async () => {
    seedRun({ attempt: 5 });
    const before = await claimRun(client(), RUN, 120);
    expect(before.ok && before.data.claimed, 'the one-row path refuses at the ceiling').toBe(false);
    expect(before.ok && before.data.run?.state, 'and until the cron ran, all a caller saw was "ready"').toBe('ready');

    const t = await cronTick();
    expect(t.body.claimed).toBe(0);
    expect(seam.runGraph).not.toHaveBeenCalled();

    const after = await claimRun(client(), RUN, 120);
    expect(after.ok && after.data.claimed).toBe(false);
    expect(after.ok && after.data.run, 'a caller now sees a failed run with its reason').toMatchObject({ state: 'failed', error: ABANDONED });
  });

  it('abandons a scheduled follow-up at the ceiling now, not on the day it was due', async () => {
    seedRun({ state: 'scheduled_followup', attempt: 5, run_after: new Date(Date.now() + 3 * 24 * 3_600_000).toISOString() });
    const t = await cronTick();
    expect(t.body.claimed).toBe(0);
    expect(run()).toMatchObject({ state: 'failed', status: 'failed', error: ABANDONED });
  });

  it.each([
    ['a cancel is in flight — it must end cancelled, not failed', { cancel_requested_at: new Date(Date.now() - 1_000).toISOString() }],
    ['its lease is still live — not the queue\'s to touch', { lease_owner: 'someone', lease_expires_at: new Date(Date.now() + 10 * 60_000).toISOString() }],
  ])('leaves a run at the ceiling alone when %s', async (_label, overrides) => {
    seedRun({ attempt: 5, ...overrides });
    const before = { ...run() };
    const t = await cronTick();
    expect(t.body.claimed).toBe(0);
    expect(run()).toEqual(before);
  });

  it('one attempt below the ceiling, the run gets its slice — and if that slice finishes it, it finishes', async () => {
    seedRun({ attempt: 4 });
    completesTheRun();
    const t = await cronTick();
    expect(t.body.claimed).toBe(1);
    expect(slices).toBe(1);
    expect(run()).toMatchObject({ state: 'completed', attempt: 5, error: null });
  });

  it('one attempt below the ceiling, only a fifth slice that completes nothing abandons it', async () => {
    seedRun({ attempt: 4 });
    parks(false);
    const t = await cronTick();
    expect(t.body.claimed, 'claimed once for the fifth slice; the next wave abandons rather than claims').toBe(1);
    expect(slices).toBe(1);
    expect(run()).toMatchObject({ state: 'failed', error: ABANDONED, attempt: 5 });
  });

  it('a run claimed in a wave but handed back unexecuted is not charged an attempt', async () => {
    // The wave claims four runs at once, and the tick gives each a slice only
    // while at least 12 s remain. The claim itself charges `attempt`, so a run
    // the tick never reached used to carry a charge for a slice it never had.
    // With the ceiling enforced by claim_ai_runs, five such hand-backs would
    // abandon a run that was never tried. The hand-back now returns the charge.
    seedRun();
    db.seed('family_automation_runs', [{ ...run(), id: OTHER, run_after: new Date(Date.now() - 30_000).toISOString() }]);
    parks(false, 80_000);                   // the first run's slice uses up the tick
    const t = await cronTick();
    expect(t.body.claimed).toBe(2);
    expect(t.body.returnedToQueue).toBe(1);
    expect(seam.runGraph).toHaveBeenCalledTimes(1);
    expect(seam.runGraph).toHaveBeenCalledWith(RUN, expect.anything());
    expect(rowOf(RUN), 'the run that had its slice is charged').toMatchObject({ state: 'ready', attempt: 1 });
    expect(rowOf(OTHER), 'the run that did not is not').toMatchObject({ state: 'ready', attempt: 0, lease_owner: null, lease_expires_at: null });
  });
});

describe('the migration', () => {
  const { path, sql: raw } = claimAiRunsMigration(ROOT);
  const sql = raw.split('\n').filter((l) => !l.trimStart().startsWith('--')).join('\n');
  const recovery = sql.slice(sql.indexOf('with recovered as'), sql.indexOf('returning id, state, plan_id, request_id, family_id'));
  const claimPass = sql.slice(sql.indexOf('with candidates as'), sql.indexOf('returning r.id'));

  it('rewrites the one function that claims runs', () => {
    expect(path).toMatch(/^supabase\/migrations\/\d{4}_a_run_with_no_attempts_left_is_abandoned_not_reclaimed\.sql$/);
    expect(sql).toContain('create or replace function public.claim_ai_runs(p_limit integer default 10, p_lease_seconds integer default 120)');
  });

  it('abandons a queued run at the ceiling in the recovery statement: no live lease, no cancel in flight', () => {
    expect(recovery).toMatch(/or \(state in \('ready','scheduled_followup'\)\s+and attempt >= max_attempts\s+and \(lease_expires_at is null or lease_expires_at < now\(\)\)\s+and cancel_requested_at is null\)/);
    // and keeps the expired-lease arm as 0263 wrote it
    expect(recovery).toMatch(/\(state = 'executing'\s+and lease_expires_at is not null\s+and lease_expires_at < now\(\)\)/);
    expect(recovery).toContain("state = case when attempt >= max_attempts then 'failed' else 'ready' end");
    expect(recovery).toContain("status = case when attempt >= max_attempts then 'failed' else status end");
    expect(recovery).toContain("'Run abandoned after the maximum number of attempts.'");
  });

  it('gives the candidates the same ceiling claimRun applies to one row', () => {
    expect(claimPass).toMatch(/and attempt < max_attempts/);
    expect(claimPass).toContain("state in ('ready','scheduled_followup')");
    expect(claimPass).toContain('cancel_requested_at is null');
    expect(claimPass).toContain('for update skip locked');
    const store = readFileSync(join(ROOT, 'lib/ai/runs/store.ts'), 'utf8');
    expect(store).toMatch(/run\.attempt < run\.max_attempts/);
  });

  it('keeps the claiming half otherwise as it was — a lease token stays a uuid, and attempt still advances', () => {
    expect(sql).toContain('lease_owner = gen_random_uuid()');
    expect(sql).not.toContain('gen_random_uuid()::text');
    expect(sql).toContain('attempt = r.attempt + 1');
  });

  it("keeps 0263's reconcile, bounded to the runs the statement dead-lettered", () => {
    expect(sql).toMatch(/select coalesce\(array_agg\(id\) filter \(where state = 'failed'\), '\{\}'\) into v_dead/);
    expect(sql.match(/r\.id = any\(v_dead\)/g)).toHaveLength(3);
    expect(sql).toMatch(/update public\.ai_plan_steps s[\s\S]*?and s\.status in \('executing', 'verifying', 'queued', 'ready'\)/);
    expect(sql).toMatch(/update public\.ai_requests q[\s\S]*?and q\.status not in \('completed', 'partially_completed', 'failed', 'cancelled'\)/);
    expect(sql).toMatch(/insert into public\.ai_run_events[\s\S]*?'run_failed'/);
  });

  it('keeps the function service-role only, as 0253 left it', () => {
    expect(sql).toContain('revoke all on function public.claim_ai_runs(integer, integer) from public, anon, authenticated');
    expect(sql).toContain('grant execute on function public.claim_ai_runs(integer, integer) to service_role');
  });

  it('ships a proof with a control one attempt below the ceiling, and pins what is left alone', () => {
    const proof = readFileSync(join(ROOT, 'docs/audit/a-run-with-no-attempts-left-is-abandoned-check.sql'), 'utf8');
    for (const claim of [
      'a ready run with no attempts left was claimed again',
      'CONTROL FAILED: a due ready run on attempt 4 of 5 was not claimed',
      'a scheduled follow-up with no attempts left was left as',
      'a cancel in flight',
      'lease is still live',
      'expected one run_failed event',
    ]) {
      expect(proof, claim).toContain(claim);
    }
    expect(proof.trim().startsWith('--')).toBe(true);
    expect(proof).toMatch(/\nbegin;\n/);
    expect(proof.trim().endsWith('rollback;')).toBe(true);
  });
});
