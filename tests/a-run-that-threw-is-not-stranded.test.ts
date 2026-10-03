// A run whose slice threw must be picked up again, not stranded.
//
// `releaseRun` is the throw path's hand-back: the cron tick calls it when
// `runGraph` throws, and `continueRun` calls it in its `finally`. It used to
// clear the lease — `lease_owner` and `lease_expires_at` to null — and leave
// the run in `executing`. The recovery pass in `claim_ai_runs` (0250, 0263)
// returns an `executing` run to `ready` only while its lease is NOT NULL and
// in the past, and the candidate query takes only `ready` and
// `scheduled_followup`; `claimRun` wants the same two states. So the released
// run belonged to nobody and was never looked at again — "working on it" for
// ever — while the cron's own comment said the recovery pass would retry it.
//
// Now the lease is SHORTENED to two minutes, not removed: the row keeps the
// exact shape that pass recovers, and the pass decides between `ready` and the
// dead-letter `failed` once the attempts are spent. Shortened rather than
// expired outright, because the cron keeps claiming waves until its 85-second
// deadline: an expired lease was claimed straight back by the tick that had
// just failed it, and a repeatable throw burnt every attempt in seconds
// (review on #900). The pass itself is SQL; this file drives the real route,
// the real `continueRun` and the real `releaseRun` against the in-memory client
// with the predicate-for-predicate stand-in in tests/helpers/claim-ai-runs.ts, and
// docs/audit/a-run-that-threw-is-not-stranded-check.sql proves the same three
// outcomes against the real function.
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { ABANDONED, claimAiRuns } from './helpers/claim-ai-runs';

const seam = vi.hoisted(() => ({ service: vi.fn(), runGraph: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: seam.service }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/ai/runs/executor', () => ({ runGraph: seam.runGraph }));
vi.mock('@/lib/ai/planner/replan-port', () => ({ replanPortFor: () => null }));

import { GET as tick } from '@/app/api/cron/ai-runs/route';
import { continueRun } from '@/lib/ai/runs/continue';
import { claimRun, RELEASE_RETRY_DELAY_MS, releaseRun } from '@/lib/ai/runs/store';

const CRON_SECRET = 'cron-fixture-secret';
const FAMILY = '00000000-0000-4000-8000-00000000a0f1';
const RUN = '00000000-0000-4000-8000-00000000a0a1';
const DONE = { status: 'completed', completed: 1, failed: 0, pending: 0, awaitingApproval: 0 };
const TICK_CADENCE_MS = 5 * 60_000;

let db: InMemorySupabase;
let errors: unknown[][];

const run = () => db.table('family_automation_runs').find((r) => r.id === RUN) as Row;
const past = (ms: number) => new Date(Date.now() - ms).toISOString();

function seedRun(overrides: Row = {}) {
  db.seed('family_automation_runs', [{
    id: RUN, family_id: FAMILY, run_type: 'concierge_plan', state: 'ready', status: 'approved', progress: {},
    attempt: 0, max_attempts: 5, lease_owner: null, lease_expires_at: null, cancel_requested_at: null, paused_at: null,
    started_at: null, completed_at: null, error: null, summary: null, plan_id: null, request_id: null, run_after: past(60_000),
    ...overrides,
  }]);
}

/** What the executor does when a slice finishes: moves the run and clears the lease in one write. */
function completesTheRun() {
  seam.runGraph.mockImplementation(async (runId: string) => {
    const row = db.table('family_automation_runs').find((r) => r.id === runId) as Row;
    Object.assign(row, { state: 'completed', status: 'executed', lease_owner: null, lease_expires_at: null, completed_at: new Date().toISOString() });
    return DONE;
  });
}

async function cronTick() {
  const res = await tick(new NextRequest('https://fixture.invalid/api/cron/ai-runs', { headers: { authorization: `Bearer ${CRON_SECRET}` } }));
  return { status: res.status, body: await res.json() as { claimed: number; executed: number; results: Array<{ runId: string; status: string }> } };
}

beforeEach(() => {
  // Only the clock is faked, so the route's deadlines, releaseRun's delay and
  // the emulated pass all read the same `now`, and a test can let a tick's
  // worth of time pass between two invocations.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-03T12:00:00.000Z'));
  vi.stubEnv('CRON_SECRET', CRON_SECRET);
  db = createInMemorySupabase({ rpc: { claim_ai_runs: (args, client) => claimAiRuns(args, client) } });
  db.seed('families', [{ id: FAMILY, name: 'Fixture', timezone: 'UTC' }]);
  errors = [];
  seam.service.mockImplementation(() => db);
  seam.runGraph.mockReset();
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args); });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const nextTick = () => vi.setSystemTime(new Date(Date.now() + TICK_CADENCE_MS));

describe('the cron tick, when a run throws', () => {
  it('leaves the run in the shape the recovery pass looks for: executing, our lease, due to run out shortly', async () => {
    seedRun();
    seam.runGraph.mockRejectedValue(new Error('provider exploded'));
    const first = await cronTick();
    expect(first.status).toBe(200);
    expect(first.body.results).toEqual([{ runId: RUN, status: 'error', completed: 0, failed: 0 }]);
    expect(errors.some((args) => /run threw/.test(String(args[0])))).toBe(true);

    const row = run();
    expect(row.state).toBe('executing');
    expect(row.attempt).toBe(1);
    expect(row.lease_owner, 'the lease is shortened, not cleared — a lease-less executing run is never recovered').not.toBeNull();
    expect(row.lease_expires_at).not.toBeNull();
    const until = Date.parse(String(row.lease_expires_at));
    expect(until, 'still held: the tick that failed it must not get it back').toBeGreaterThan(Date.now());
    expect(until, 'but not for the whole 180-second lease').toBeLessThanOrEqual(Date.now() + RELEASE_RETRY_DELAY_MS);
  });

  it('does not claim a repeatable throw straight back in its next wave — one attempt per tick, not five', async () => {
    // The review's case: the loop keeps claiming until the 85-second deadline,
    // and an expired lease was recovered by the very next wave of the same
    // invocation. A fast, repeatable rejection then burnt every attempt and
    // dead-lettered the run in seconds. The shortened lease outlives the tick.
    seedRun();
    seam.runGraph.mockRejectedValue(new Error('provider exploded'));
    const first = await cronTick();
    expect(first.body.claimed).toBe(1);
    expect(seam.runGraph).toHaveBeenCalledTimes(1);
    expect(run()).toMatchObject({ state: 'executing', attempt: 1 });
    expect(run().error ?? null, 'and it is not dead-lettered').toBeNull();
  });

  it('so the next tick recovers it, claims it again and runs it — it used to be stranded for ever', async () => {
    seedRun();
    seam.runGraph.mockRejectedValueOnce(new Error('provider exploded'));
    await cronTick();
    completesTheRun();

    nextTick();
    const second = await cronTick();
    expect(second.body.claimed, 'the stranded run was never claimed again').toBe(1);
    expect(second.body.results).toEqual([{ runId: RUN, status: 'completed', completed: 1, failed: 0 }]);
    expect(seam.runGraph).toHaveBeenCalledTimes(2);
    expect(run()).toMatchObject({ state: 'completed', attempt: 2, lease_owner: null });
  });

  it('dead-letters a run whose attempts are spent instead of retrying it for ever', async () => {
    seedRun({ attempt: 4 });
    seam.runGraph.mockRejectedValue(new Error('provider exploded'));
    await cronTick();
    expect(run()).toMatchObject({ state: 'executing', attempt: 5 });

    nextTick();
    const second = await cronTick();
    expect(second.body.claimed).toBe(0);
    expect(seam.runGraph).toHaveBeenCalledTimes(1);
    expect(run()).toMatchObject({ state: 'failed', status: 'failed', error: ABANDONED, lease_owner: null });
    expect(run().completed_at).toBeTruthy();
  });

  it('does not hand back a run the executor already moved on', async () => {
    // A slice that parks or finishes clears the lease itself; the finally/catch
    // hand-back then matches nothing and must change nothing.
    seedRun();
    seam.runGraph.mockImplementation(async (runId: string) => {
      const row = db.table('family_automation_runs').find((r) => r.id === runId) as Row;
      Object.assign(row, { state: 'awaiting_approval', status: 'pending', lease_owner: null, lease_expires_at: null });
      throw new Error('threw after parking');
    });
    await cronTick();
    expect(run()).toMatchObject({ state: 'awaiting_approval', lease_owner: null, lease_expires_at: null });
  });
});

describe('an interactive continuation whose slice throws', () => {
  it('rethrows, and leaves the run recoverable by the next claim_ai_runs', async () => {
    seedRun();
    seam.runGraph.mockRejectedValue(new Error('provider exploded'));
    await expect(continueRun(RUN, { db: db as unknown as SupabaseClient<Database>, budgetMs: 5_000 })).rejects.toThrow('provider exploded');

    const row = run();
    expect(row.state).toBe('executing');
    expect(row.lease_owner).not.toBeNull();
    expect(Date.parse(String(row.lease_expires_at))).toBeLessThanOrEqual(Date.now() + RELEASE_RETRY_DELAY_MS);

    const held = await db.rpc('claim_ai_runs', { p_limit: 10, p_lease_seconds: 120 });
    expect(held.data, 'not yet: the shortened lease still holds the run for this tick').toEqual([]);
    nextTick();
    const { data } = await db.rpc('claim_ai_runs', { p_limit: 10, p_lease_seconds: 120 });
    expect(data, 'the recovery pass picks the run up on the next tick').toEqual([RUN]);
    expect(run()).toMatchObject({ state: 'executing', attempt: 2 });
  });

  it('is not claimable by another interactive continuation until the pass has run — the same as a crashed worker', async () => {
    seedRun();
    seam.runGraph.mockRejectedValue(new Error('provider exploded'));
    await continueRun(RUN, { db: db as unknown as SupabaseClient<Database>, budgetMs: 5_000 }).catch(() => undefined);
    const again = await claimRun(db as unknown as SupabaseClient<Database>, RUN, 120);
    expect(again.ok && !again.data.claimed, 'claimRun takes only ready/scheduled_followup runs').toBe(true);
  });
});

describe('releaseRun', () => {
  const client = () => db as unknown as SupabaseClient<Database>;

  it('shortens our own lease on an executing run to the retry delay and keeps everything else', async () => {
    const owner = randomUUID();
    seedRun({ state: 'executing', attempt: 1, lease_owner: owner, lease_expires_at: new Date(Date.now() + 180_000).toISOString() });
    await releaseRun(client(), RUN, owner);
    const row = run();
    expect(row).toMatchObject({ state: 'executing', attempt: 1, lease_owner: owner });
    expect(Date.parse(String(row.lease_expires_at))).toBe(Date.now() + RELEASE_RETRY_DELAY_MS);
  });

  it('outlives any one invocation and falls inside the dispatcher cadence', () => {
    // 85 s is the cron tick's box (TICK_BUDGET_MS); 300 s is the five-minute
    // dispatcher. Between the two, the failing tick cannot reclaim the run and
    // the next tick does.
    expect(RELEASE_RETRY_DELAY_MS).toBeGreaterThan(85_000);
    expect(RELEASE_RETRY_DELAY_MS).toBeLessThan(TICK_CADENCE_MS);
  });

  it.each([
    ['another worker now holds it', { state: 'executing', lease_owner: 'someone-else', lease_expires_at: new Date(Date.now() + 120_000).toISOString() }],
    ['the executor already parked it', { state: 'ready', lease_owner: null, lease_expires_at: null }],
  ])('touches nothing when %s', async (_label, overrides) => {
    seedRun(overrides);
    const before = { ...run() };
    await releaseRun(client(), RUN, 'our-token');
    expect(run()).toEqual(before);
  });

  it('reports a refused write and does not throw into the tick', async () => {
    seedRun({ state: 'executing', lease_owner: 'ours', lease_expires_at: new Date(Date.now() + 120_000).toISOString() });
    const before = db.from;
    db.from = (() => { throw new Error('connection refused'); }) as InMemorySupabase['from'];
    try {
      await expect(releaseRun({ from: () => ({ update: () => ({ eq: () => ({ eq: () => ({ eq: async () => ({ data: null, error: { code: '08006', message: 'connection refused' } }) }) }) }) }) } as unknown as SupabaseClient<Database>, RUN, 'ours')).resolves.toBeUndefined();
    } finally {
      db.from = before;
    }
    expect(String(errors[0]?.[0])).toMatch(/failed to hand the run back to the recovery pass/);
  });
});
