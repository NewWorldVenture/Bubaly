import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { claimRun, releaseRun } from '@/lib/ai/runs/store';

const ROOT = join(__dirname, '..');
const FAMILY = '00000000-0000-4000-8000-00000000fa01';
const USER = '00000000-0000-4000-8000-0000000000a1';
const RUN = '00000000-0000-4000-8000-00000000ru01';

/**
 * `attempt` decides whether a run is ABANDONED, and successful work spends it.
 *
 * Three places read the counter, and they do not agree about what it counts:
 *
 *   claim_ai_runs pass 1 (0250:434)   state = case when attempt >= max_attempts
 *                                       then 'failed' ...
 *                                     error = 'Run abandoned after the maximum
 *                                       number of attempts.'
 *   0263_dead_letter_reconcile:101    the same, as the dead-letter path
 *   store.claimRun (store.ts:629)     claimable = ... && attempt < max_attempts
 *
 * The error text and the dead-letter framing both say this is a FAILURE budget.
 * But every claim increments it — `claim_ai_runs` at 0250:461 and `claimRun` at
 * store.ts:638 — and nothing anywhere resets it. `parkForContinuation`
 * (executor.ts:661) clears the lease and sets `run_after`, and leaves `attempt`
 * exactly where the claim left it.
 *
 * So a run that is working perfectly spends its abandonment budget by making
 * progress. The executor slices at PER_RUN_BUDGET_MS = 25s inside an 85s tick,
 * and parks for an approval every time it needs a human, so five slices is an
 * ordinary long plan, not a pathological one.
 *
 * That the run-level counter was not meant to be the retry mechanism is visible
 * in the schema: per-step retries have their own column, `ai_plan_steps.max_retries`
 * (default 2). `attempt` is the run's abandonment budget, and successful slices
 * are eating it.
 *
 * This test drives the REAL `claimRun` against the in-memory PostgREST stand-in
 * — real filters, the real compare-and-set on `attempt` — and shows a healthy
 * run becoming unresumable after five successful slices.
 */

function freshDb(): SupabaseClient<Database> {
  const db: InMemorySupabase = createInMemorySupabase({
    userId: USER,
    defaults: {
      family_automation_runs: {
        run_type: 'concierge_plan', state: 'ready', status: 'approved', progress: {},
        attempt: 0, max_attempts: 5, lease_owner: null, lease_expires_at: null,
        cancel_requested_at: null, paused_at: null, started_at: null, completed_at: null,
        error: null, summary: null, plan_id: null, request_id: null,
      },
    },
  });
  return db as unknown as SupabaseClient<Database>;
}

/** One healthy slice: claim it, do work, park it back to `ready` the way the executor does. */
async function healthySlice(db: SupabaseClient<Database>): Promise<boolean> {
  const claim = await claimRun(db, RUN, 120);
  if (!claim.ok || !claim.data.claimed) return false;
  // parkForContinuation: lease cleared, state back to `ready`, due immediately.
  // It does not touch `attempt`, and neither does anything else.
  await releaseRun(db, RUN, claim.data.leaseOwner as string);
  await db.from('family_automation_runs')
    .update({ state: 'ready', lease_owner: null, lease_expires_at: null, run_after: new Date(0).toISOString() })
    .eq('id', RUN);
  return true;
}

async function attemptOf(db: SupabaseClient<Database>): Promise<number> {
  const { data } = await db.from('family_automation_runs').select('attempt').eq('id', RUN).maybeSingle();
  return (data as { attempt: number } | null)?.attempt ?? -1;
}

let db: SupabaseClient<Database>;

beforeEach(async () => {
  db = freshDb();
  await db.from('family_automation_runs').insert({
    id: RUN, family_id: FAMILY, run_after: new Date(0).toISOString(),
  } as never);
});

describe('a successful slice must not spend a retry', () => {
  it('five healthy slices exhaust the abandonment budget, and the sixth is refused', async () => {
    for (let i = 1; i <= 5; i += 1) {
      expect(await healthySlice(db), `slice ${i} should have been claimable`).toBe(true);
      expect(await attemptOf(db), `after slice ${i}`).toBe(i);
    }

    // Nothing has gone wrong. The run is `ready`, unleased, due, not cancelled.
    const { data: row } = await db.from('family_automation_runs')
      .select('state, lease_owner, cancel_requested_at, error').eq('id', RUN).maybeSingle();
    expect(row).toMatchObject({ state: 'ready', lease_owner: null, cancel_requested_at: null, error: null });

    // And it can never be picked up again by any interactive path: the resume
    // button, the kick after an approval answer, a step re-run. All of them go
    // through claimRun.
    const sixth = await claimRun(db, RUN, 120);
    expect(sixth.ok).toBe(true);
    expect(sixth.ok && sixth.data.claimed, 'a healthy run was refused for making progress').toBe(false);
  });

  it('the refusal is silent — no error, no state change, nothing a caller can see', async () => {
    for (let i = 0; i < 5; i += 1) await healthySlice(db);
    const before = await db.from('family_automation_runs').select('*').eq('id', RUN).maybeSingle();

    const refused = await claimRun(db, RUN, 120);
    // Not an error: `ok` with `claimed: false`, which continueRun reports as
    // `status: run.state` — i.e. "ready". A caller sees a ready run that will
    // not run, and no reason why.
    expect(refused.ok).toBe(true);
    expect(refused.ok && refused.data.claimed).toBe(false);
    expect(refused.ok && refused.data.run?.state).toBe('ready');

    const after = await db.from('family_automation_runs').select('*').eq('id', RUN).maybeSingle();
    expect(after.data).toEqual(before.data);
  });

  it('a run below the ceiling is claimable — the mechanism is the count, not the state', async () => {
    // Non-vacuity. Four slices leaves attempt at 4 < 5, and the fifth claim works.
    for (let i = 0; i < 4; i += 1) await healthySlice(db);
    expect(await attemptOf(db)).toBe(4);
    const fifth = await claimRun(db, RUN, 120);
    expect(fifth.ok && fifth.data.claimed, 'attempt 4 of 5 should still be claimable').toBe(true);
  });

  it('nothing in the codebase ever resets the counter', () => {
    // The reason the above is terminal rather than transient. If a reset is
    // ever added, this fails and the finding should be revisited.
    for (const rel of [
      'lib/ai/runs/store.ts', 'lib/ai/runs/executor.ts', 'lib/ai/runs/continue.ts',
      'lib/ai/runs/controls.ts', 'lib/ai/runs/intake.ts',
    ]) {
      const src = readFileSync(join(ROOT, rel), 'utf8');
      expect(src, `${rel} resets attempt — re-check this finding`).not.toMatch(/attempt:\s*0\b/);
    }
  });

  it('the two claim paths disagree, which is why the cron can still advance it', () => {
    // store.claimRun refuses at the ceiling; the cron RPC has no such filter in
    // its claiming pass, so a run past max_attempts is unreachable by every
    // human-initiated path while the cron keeps moving it. That inconsistency
    // is the only reason this is not a total deadlock — and it is itself a bug.
    const rpc = readFileSync(join(ROOT, 'supabase/migrations/0250_ai_runtime_core.sql'), 'utf8');
    const claimPass = rpc.slice(rpc.indexOf('with candidates as'), rpc.indexOf('returning r.id'));
    expect(claimPass, 'the claiming pass gained an attempt ceiling — re-check this finding').not.toMatch(/attempt\s*<\s*.*max_attempts/);
    expect(claimPass, 'the claiming pass no longer increments attempt').toMatch(/attempt = r\.attempt \+ 1/);

    // And the counter it spends is the one the recovery pass calls abandonment.
    expect(rpc).toMatch(/case when attempt >= max_attempts then 'failed'/);
    expect(rpc).toContain('Run abandoned after the maximum number of attempts.');

    // Per-step retries are a different column entirely, which is the evidence
    // that run-level `attempt` was never meant to be the retry mechanism.
    expect(rpc).toMatch(/max_retries/);
  });
});
