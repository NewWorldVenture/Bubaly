import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { claimRun, releaseRun } from '@/lib/ai/runs/store';
import { claimAiRunsMigration } from './helpers/claim-ai-runs';

const ROOT = join(__dirname, '..');
const FAMILY = '00000000-0000-4000-8000-00000000fa01';
const USER = '00000000-0000-4000-8000-0000000000a1';
const RUN = '00000000-0000-4000-8000-00000000ru01';

/**
 * `attempt` decides whether a run is ABANDONED, and successful work used to
 * spend it.
 *
 * Three places read the counter, and they agree about what it counts:
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
 * store.ts:638 — and nothing anywhere reset it. `parkForContinuation` cleared
 * the lease and set `run_after`, and left `attempt` exactly where the claim
 * left it.
 *
 * So a run that was working perfectly spent its abandonment budget by making
 * progress. The executor slices at PER_RUN_BUDGET_MS = 25s inside an 85s tick,
 * and parks for an approval every time it needs a human, so five slices is an
 * ordinary long plan, not a pathological one. After five, every human-initiated
 * path (resume, the kick after an approval answer, a step re-run) was refused
 * silently, and the first genuine worker death dead-lettered the run as
 * "abandoned" (finalaudit Q40).
 *
 * That the run-level counter was not meant to be the retry mechanism is visible
 * in the schema: per-step retries have their own column, `ai_plan_steps.max_retries`
 * (default 2). `attempt` is the run's abandonment budget.
 *
 * The first half of Q40's filed fix: the executor's parks now hand the budget
 * back when, and ONLY when, the slice left more steps satisfied than it found
 * (run-executor.test.ts pins that through the real `runGraphWith`). A slice that
 * completed nothing keeps the charge, which is what still lets a run that never
 * progresses terminate — the proof Q40 asked for is the first case below. The
 * second half — the same ceiling inside `claim_ai_runs`, so that a run the
 * one-row path refuses is abandoned by the cron rather than claimed for ever —
 * is the migration the last case pins (tests/a-run-with-no-attempts-left-is-
 * abandoned.test.ts drives it).
 *
 * This file drives the REAL `claimRun` against the in-memory PostgREST stand-in
 * — real filters, the real compare-and-set on `attempt` — with the park written
 * the way the executor writes it.
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

/**
 * One slice: claim it, do work, park it back to `ready` the way the executor
 * does. `progressed` is what parkForContinuation knows at the park — whether
 * this slice left more steps satisfied than it found — and is the only thing
 * that touches `attempt` (executor.ts, budgetReset).
 */
async function slice(db: SupabaseClient<Database>, progressed: boolean): Promise<boolean> {
  const claim = await claimRun(db, RUN, 120);
  if (!claim.ok || !claim.data.claimed) return false;
  await releaseRun(db, RUN, claim.data.leaseOwner as string);
  await db.from('family_automation_runs')
    .update({ state: 'ready', lease_owner: null, lease_expires_at: null, run_after: new Date(0).toISOString(), ...(progressed ? { attempt: 0 } : {}) })
    .eq('id', RUN);
  return true;
}
const sliceWithoutProgress = (db: SupabaseClient<Database>) => slice(db, false);
const sliceWithProgress = (db: SupabaseClient<Database>) => slice(db, true);

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

describe('a successful slice must not spend a retry (Q40)', () => {
  it('a run that never progresses still terminates: five slices without progress exhaust the budget, and the sixth is refused', async () => {
    for (let i = 1; i <= 5; i += 1) {
      expect(await sliceWithoutProgress(db), `slice ${i} should have been claimable`).toBe(true);
      expect(await attemptOf(db), `after slice ${i}`).toBe(i);
    }

    // The run is `ready`, unleased, due, not cancelled — and has done nothing
    // five times over. That is what the abandonment budget is for.
    const { data: row } = await db.from('family_automation_runs')
      .select('state, lease_owner, cancel_requested_at, error').eq('id', RUN).maybeSingle();
    expect(row).toMatchObject({ state: 'ready', lease_owner: null, cancel_requested_at: null, error: null });

    const sixth = await claimRun(db, RUN, 120);
    expect(sixth.ok).toBe(true);
    expect(sixth.ok && sixth.data.claimed, 'a run that made no progress five times must stop').toBe(false);
  });

  it('a slice that completed a step hands the budget back, so a long healthy run stays claimable', async () => {
    // Eight slices, each finishing work: more than the whole budget, and every
    // one of them claimable. This is the case that used to be refused at six.
    for (let i = 1; i <= 8; i += 1) {
      expect(await sliceWithProgress(db), `healthy slice ${i} was refused for making progress`).toBe(true);
      expect(await attemptOf(db), `after healthy slice ${i}`).toBe(0);
    }
    const ninth = await claimRun(db, RUN, 120);
    expect(ninth.ok && ninth.data.claimed).toBe(true);
  });

  it('progress only hands back what this run has spent — it does not bank credit for a later run that stalls', async () => {
    // Three stalls, one good slice, then five more stalls: the good slice reset
    // the counter, so the stalls after it are counted from zero and the SIXTH of
    // them is the one refused — not the third.
    for (let i = 0; i < 3; i += 1) await sliceWithoutProgress(db);
    expect(await attemptOf(db)).toBe(3);
    await sliceWithProgress(db);
    expect(await attemptOf(db)).toBe(0);
    for (let i = 1; i <= 5; i += 1) expect(await sliceWithoutProgress(db), `stall ${i} after the reset`).toBe(true);
    const refused = await claimRun(db, RUN, 120);
    expect(refused.ok && refused.data.claimed).toBe(false);
  });

  it('the refusal is silent — no error, no state change, nothing a caller can see', async () => {
    for (let i = 0; i < 5; i += 1) await sliceWithoutProgress(db);
    const before = await db.from('family_automation_runs').select('*').eq('id', RUN).maybeSingle();

    const refused = await claimRun(db, RUN, 120);
    // Not an error: `ok` with `claimed: false`, which continueRun reports as
    // `status: run.state` — i.e. "ready". A caller sees a ready run that will
    // not run, and no reason why. (Still true; it is why the budget has to be
    // spent only on abandonment.)
    expect(refused.ok).toBe(true);
    expect(refused.ok && refused.data.claimed).toBe(false);
    expect(refused.ok && refused.data.run?.state).toBe('ready');

    const after = await db.from('family_automation_runs').select('*').eq('id', RUN).maybeSingle();
    expect(after.data).toEqual(before.data);
  });

  it('a run below the ceiling is claimable — the mechanism is the count, not the state', async () => {
    // Non-vacuity. Four stalls leave attempt at 4 < 5, and the fifth claim works.
    for (let i = 0; i < 4; i += 1) await sliceWithoutProgress(db);
    expect(await attemptOf(db)).toBe(4);
    const fifth = await claimRun(db, RUN, 120);
    expect(fifth.ok && fifth.data.claimed, 'attempt 4 of 5 should still be claimable').toBe(true);
  });

  it('the budget is handed back by two named helpers and nothing else: progress, and a person asking again', () => {
    // Two resets, each guarded. The executor's `budgetReset` is guarded by
    // progress; the store's `freshBudget` is guarded by WHO writes — only the
    // controls a member of the family invokes (resume, re-run a step, edit a
    // step) and an approval decision spread it. A bare `attempt: 0` anywhere
    // else — the intake, the kick, a park — would stop genuinely stuck runs
    // from ever dead-lettering, which is the half of Q40 that argued against a
    // bare reset. The person's re-entry is the one case that argument does not
    // reach: a human asking again is a new budget by definition
    // (tests/a-run-a-person-asks-for-again-gets-its-attempts-back.test.ts).
    for (const rel of ['lib/ai/runs/continue.ts', 'lib/ai/runs/controls.ts', 'lib/ai/runs/intake.ts', 'lib/services/approvals/index.ts', 'app/api/cron/ai-runs/route.ts']) {
      const src = readFileSync(join(ROOT, rel), 'utf8');
      expect(src, `${rel} resets attempt — the reset belongs to budgetReset and freshBudget alone`).not.toMatch(/attempt:\s*0\b/);
    }
    const store = readFileSync(join(ROOT, 'lib/ai/runs/store.ts'), 'utf8');
    expect(store.match(/attempt:\s*0\b/g), 'one reset, in freshBudget').toHaveLength(1);
    expect(store).toContain('export function freshBudget()');
    expect(store).toContain('return { attempt: 0 };');
    const executor = readFileSync(join(ROOT, 'lib/ai/runs/executor.ts'), 'utf8');
    expect(executor.match(/attempt:\s*0\b/g), 'one reset, in budgetReset').toHaveLength(1);
    expect(executor).toContain('function budgetReset(progressed: boolean)');
    expect(executor).toContain("return progressed ? { attempt: 0 } : {};");
    // Every park goes through it, so no park can forget the guard.
    expect(executor.match(/budgetReset\(/g)?.length).toBe(4);
  });

  it('the two claim paths agree: the cron abandons a run at the ceiling claimRun refuses at (Q40, second half)', () => {
    // store.claimRun refuses at the ceiling. The cron RPC's claiming pass had no
    // such filter, so a run past max_attempts was unreachable by every
    // human-initiated path while the cron kept moving it — and its dead-letter
    // arm never reached a parked run, because that arm only ran for an expired
    // lease on an `executing` row. The current definition closes both.
    const { sql } = claimAiRunsMigration(ROOT);
    const recovery = sql.slice(sql.indexOf('with recovered as'), sql.indexOf('returning id, state'));
    expect(recovery, 'a queued run at the ceiling is abandoned').toMatch(/state in \('ready','scheduled_followup'\)\s+and attempt >= max_attempts/);
    const claimPass = sql.slice(sql.indexOf('with candidates as'), sql.indexOf('returning r.id'));
    expect(claimPass, 'the claiming pass has the ceiling').toMatch(/and attempt < max_attempts/);
    expect(claimPass, 'and still increments attempt').toMatch(/attempt = r\.attempt \+ 1/);
    const store = readFileSync(join(ROOT, 'lib/ai/runs/store.ts'), 'utf8');
    expect(store, 'the one-row path keeps its ceiling').toMatch(/run\.attempt < run\.max_attempts/);

    // And the counter both paths stop at is the one the recovery arm calls abandonment.
    expect(sql).toMatch(/case when attempt >= max_attempts then 'failed'/);
    expect(sql).toContain('Run abandoned after the maximum number of attempts.');

    // The premise, kept as history: 0250's original claiming pass had no ceiling,
    // and per-step retries were always a different column, which is the evidence
    // that run-level `attempt` was never meant to be the retry mechanism.
    const original = readFileSync(join(ROOT, 'supabase/migrations/0250_ai_runtime_core.sql'), 'utf8');
    const originalPass = original.slice(original.indexOf('with candidates as'), original.indexOf('returning r.id'));
    expect(originalPass).not.toMatch(/attempt\s*<\s*.*max_attempts/);
    expect(original).toMatch(/max_retries/);
  });
});
