// A run a person asks for again gets its attempt budget back (finalaudit Q40,
// follow-up to its second half).
//
// `attempt` is the run's abandonment budget: the slices in a row that completed
// nothing. At `max_attempts` the recovery arm of `claim_ai_runs` dead-letters
// the run and `claimRun` refuses to lease it. Four writes put a run back to
// `ready` because a member of the family asked: resume, re-run a step, edit a
// step (lib/ai/runs/controls.ts) and an approval decision
// (lib/services/approvals). Every one of them told the person Bubaly would pick
// the run up, and not one touched `attempt`. For a run that had spent its
// budget that promise was false twice over: the kick that follows each write
// goes through `claimRun`, which answered `claimed: false` without a word, and
// the next cron tick's recovery arm abandoned the run again. "Try that step
// again" on an abandoned run produced a run abandoned again, with nothing a
// person could do about it; an approval granted to a run parked at the ceiling
// was consumed by a run that then died.
//
// `freshBudget()` (lib/ai/runs/store.ts) is the `attempt: 0` each of those
// writes now carries: a human asking again is a new budget, the way a slice
// that made progress is (executor.ts, budgetReset). This file drives the real
// controls, the real `claimRun` and the claim pass's predicate-for-predicate
// stand-in against the in-memory client; the control case is the same row
// WITHOUT a person's re-entry, which is what the person's run met before.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { rerunStep, resumeRun } from '@/lib/ai/runs/controls';
import { claimRun } from '@/lib/ai/runs/store';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { ABANDONED, claimAiRuns } from './helpers/claim-ai-runs';

const ROOT = join(__dirname, '..');
const FAMILY = '00000000-0000-4000-8000-00000000f0a1';
const MEMBER = '00000000-0000-4000-8000-00000000f0a2';
const RUN = '00000000-0000-4000-8000-00000000f0b1';
const PLAN = '00000000-0000-4000-8000-00000000f0c1';
const STEP = '00000000-0000-4000-8000-00000000f0d1';
const REQUEST = '00000000-0000-4000-8000-00000000f0e1';
const CEILING = 5;

let db: InMemorySupabase;
const client = () => db as unknown as SupabaseClient<Database>;
const run = () => db.table('family_automation_runs').find((r) => r.id === RUN) as Row;

const scope = (): ServiceScope => ({
  db: client(), familyId: FAMILY, userId: 'auth-parent', memberId: MEMBER, role: 'parent', actorKind: 'member', tz: 'UTC',
} as unknown as ServiceScope);

/** A run whose budget is spent, in the state the recovery arm leaves it. */
function seedAbandoned(over: Row = {}) {
  db.seed('family_automation_runs', [{
    id: RUN, family_id: FAMILY, run_type: 'concierge_plan', plan_id: PLAN, request_id: REQUEST, requested_by_member_id: MEMBER,
    state: 'failed', status: 'failed', error: ABANDONED, progress: {},
    attempt: CEILING, max_attempts: CEILING, lease_owner: null, lease_expires_at: null, cancel_requested_at: null, paused_at: null,
    started_at: '2026-10-03T11:00:00.000Z', completed_at: '2026-10-03T11:30:00.000Z', run_after: '2026-10-03T11:30:00.000Z',
    ...over,
  }]);
  db.seed('ai_requests', [{ id: REQUEST, family_id: FAMILY, status: 'failed', error: ABANDONED }]);
  db.seed('ai_plan_steps', [{
    id: STEP, family_id: FAMILY, plan_id: PLAN, sequence: 0, step_type: 'act', tool_name: 'calendar.createEvent',
    description: 'Add the dentist', input_json: { title: 'Dentist' }, dependency_ids: [], condition: null,
    status: 'failed', approval_required: false, approval_id: null, risk_level: 'low', retry_count: 2, max_retries: 2,
    result_json: null, error: 'The calendar service timed out.', started_at: null, completed_at: null,
  }]);
  db.seed('ai_tool_calls', [{
    id: '00000000-0000-4000-8000-00000000f0f1', family_id: FAMILY, run_id: RUN, plan_step_id: STEP, tool_name: 'calendar.createEvent',
    state: 'failed', attempt: 1, resource_id: null, resource_table: null, created_at: '2026-10-03T11:20:00.000Z',
  }]);
}

beforeEach(() => {
  db = createInMemorySupabase({ rpc: { claim_ai_runs: (args, c) => claimAiRuns(args, c) } });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('a run a person asks for again', () => {
  it('re-run a step on an abandoned run: the kick claims it and the next tick takes it, instead of abandoning it again', async () => {
    seedAbandoned();

    const asked = await rerunStep(scope(), RUN, STEP, { db: client() });
    expect(asked).toMatchObject({ ok: true, data: { rerun: true } });
    expect(run()).toMatchObject({ state: 'ready', attempt: 0, error: null, completed_at: null });

    // The kick after the control (intake.ts → continueRun → claimRun).
    const kick = await claimRun(client(), RUN);
    expect(kick).toMatchObject({ ok: true, data: { claimed: true } });
    expect(run()).toMatchObject({ state: 'executing', attempt: 1 });
    expect(run().lease_owner).toBeTruthy();
  });

  it("the cron's claim pass, when the kick did not get there first, takes it rather than dead-lettering it", () => {
    seedAbandoned();
    return rerunStep(scope(), RUN, STEP, { db: client() }).then((asked) => {
      expect(asked.ok).toBe(true);
      expect(claimAiRuns({ p_limit: 10 }, db)).toEqual([RUN]);
      expect(run()).toMatchObject({ state: 'executing', attempt: 1, error: null });
    });
  });

  it('resume a run paused at the ceiling: claimable again', async () => {
    seedAbandoned({ state: 'paused', status: 'paused', error: null, completed_at: null, paused_at: '2026-10-03T11:40:00.000Z' });

    const asked = await resumeRun(scope(), RUN, { db: client() });
    expect(asked).toMatchObject({ ok: true, data: { state: 'ready' } });
    expect(run()).toMatchObject({ state: 'ready', attempt: 0, paused_at: null });

    const kick = await claimRun(client(), RUN);
    expect(kick).toMatchObject({ ok: true, data: { claimed: true } });
    expect(run()).toMatchObject({ state: 'executing', attempt: 1 });
  });

  it('control: the same row at the ceiling without a person asking is refused by the kick and abandoned by the tick', async () => {
    // What every re-entry produced before: `ready`, due, budget spent.
    seedAbandoned({ state: 'ready', status: 'approved', error: null, completed_at: null, run_after: '2026-10-03T11:30:00.000Z' });

    const kick = await claimRun(client(), RUN);
    expect(kick).toMatchObject({ ok: true, data: { claimed: false } });
    expect(run()).toMatchObject({ state: 'ready', attempt: CEILING });

    expect(claimAiRuns({ p_limit: 10 }, db)).toEqual([]);
    expect(run()).toMatchObject({ state: 'failed', status: 'failed', error: ABANDONED, attempt: CEILING });
  });

  it('every write that puts a run back to ready because a person asked carries the fresh budget', () => {
    const controls = readFileSync(join(ROOT, 'lib/ai/runs/controls.ts'), 'utf8');
    const approvals = readFileSync(join(ROOT, 'lib/services/approvals/index.ts'), 'utf8');

    // Each `updateRun(... { state: 'ready', ... })` patch, split at the call so
    // a patch is checked against its own fields and nobody else's.
    const readyPatches = (src: string) => src.split('updateRun(').slice(1).filter((chunk) => /state: 'ready',/.test(chunk.split('}, { db })')[0]));
    const controlPatches = readyPatches(controls);
    const approvalPatches = readyPatches(approvals);
    expect(controlPatches, 'resume, re-run a step, edit a step').toHaveLength(3);
    expect(approvalPatches, 'the decision that returns a run to the queue').toHaveLength(1);
    for (const patch of [...controlPatches, ...approvalPatches]) {
      expect(patch.split('}, { db })')[0]).toContain('...freshBudget()');
    }
  });
});
