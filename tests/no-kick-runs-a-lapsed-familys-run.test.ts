// N8 — every way a run is kicked asks whether the family still has Ask Bubaly.
//
// The ai-runs cron deferred the runs of a family that lost Ask Bubaly (a trial
// that ended unpaid, a plan below Family Basic, the feature switched Off), but
// it is only one of the doors to execution. `kickRun` → `continueRun` →
// `claimRun` → executor asked nothing, and it is reached from an approval
// decision (`decide` → `foldIntoRun`), from the notifications cron's
// settled-run sweep (`resumeSettledRuns`), from the routine cron and from the
// run controls. A run parked on an approval while the family was entitled ran
// the moment someone decided it, or the moment the sweep found it, after the
// lapse.
//
// `continueRun` now asks before it executes: a family without Ask Bubaly has
// its run handed back to the queue a day out, as the cron does, and a plan
// that cannot be read hands it back now. Driven through the real approval
// service, the real `kickRun` / `continueRun` / `claimRun`, and the real
// executor port over the in-memory database. Only the tool itself is a
// recorder, and `after()` (which needs a live request) runs its callback here.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, withFaults, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({ db: null as unknown, after: [] as Promise<unknown>[], executed: [] as string[] }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db, createServer: async () => h.db }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: (task: () => Promise<unknown>) => { h.after.push(task()); },
}));
vi.mock('@/lib/ai/tools/execute', () => ({
  executeTool: async (_scope: unknown, name: string) => {
    h.executed.push(name);
    return { status: 'ok', data: { id: 'budget-1' }, summary: `Did ${name}`, toolCallId: 'call-1', verified: true };
  },
}));

const { createExecutorPort, runGraphWith } = await import('@/lib/ai/runs/executor');
const { decide, resumeSettledRuns } = await import('@/lib/services/approvals');
const { continueRun } = await import('@/lib/ai/runs/continue');

const FAMILY = '00000000-0000-4000-8000-0000000a8e01';
const DANA = { member: '00000000-0000-4000-8000-0000000a8e11', user: '00000000-0000-4000-8000-0000000a8e21' };
const REQUEST = '00000000-0000-4000-8000-0000000a8e31';
const PLAN = '00000000-0000-4000-8000-0000000a8e32';
const RUN = '00000000-0000-4000-8000-0000000a8e33';
const STEP = '00000000-0000-4000-8000-0000000a8e34';
const NOW = new Date('2026-10-14T12:00:00Z');
const DAY_MS = 24 * 60 * 60_000;

let db: InMemorySupabase;
const client = () => h.db as SupabaseClient<Database>;
const dana = (): ServiceScope => ({
  db: client(), familyId: FAMILY, userId: DANA.user, memberId: DANA.member, role: 'parent', actorKind: 'member', tz: 'UTC', now: NOW,
});
const run = () => db.table('family_automation_runs').find((r) => r.id === RUN) as Row;
const approval = () => db.table('approval_requests')[0] as Row;

/** The ways a family stops having Ask Bubaly. */
const lapses = [
  ['whose trial ended unpaid', () => {
    db.replace('subscriptions', []);
    Object.assign(db.table('families')[0], { trial_ends_at: new Date(NOW.getTime() - DAY_MS).toISOString() });
  }],
  ['on Free', () => { db.replace('subscriptions', []); }],
] as const;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  db = createInMemorySupabase({ defaults: { approval_requests: { approvals: [], edited_payload: null, plan_step_ids: [] } } });
  h.db = db;
  h.after = [];
  h.executed = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  // A Family Basic family asked Bubaly to raise a budget; the step is held
  // for a parent's yes. Filed while the family had Ask Bubaly.
  db.seed('families', [{ id: FAMILY, name: 'The Riveras', timezone: 'UTC', trial_ends_at: null, closed_at: null }]);
  db.seed('subscriptions', [{ id: 'sub-riveras', family_id: FAMILY, plan: 'basic', status: 'active', current_period_end: '2099-01-01T00:00:00Z' }]);
  db.seed('family_members', [{ id: DANA.member, family_id: FAMILY, user_id: DANA.user, role: 'parent', is_active: true, display_name: 'Dana' }]);
  db.seed('ai_requests', [{ id: REQUEST, family_id: FAMILY, requested_by: DANA.user, requested_by_member_id: DANA.member, kind: 'concierge', request_text: 'Raise the grocery budget to $400', status: 'ready' }]);
  db.seed('ai_plans', [{ id: PLAN, family_id: FAMILY, request_id: REQUEST, version: 1, status: 'approved', risk_level: 'medium' }]);
  db.seed('ai_plan_steps', [{
    id: STEP, family_id: FAMILY, plan_id: PLAN, sequence: 0, step_type: 'act', tool_name: 'finances.updateBudget', description: 'Raise the grocery budget',
    input_json: { category: 'Groceries', amount: 400 }, dependency_ids: [], condition: null, status: 'queued', approval_required: true, approval_id: null,
    risk_level: 'medium', retry_count: 0, max_retries: 2, result_json: null, error: null,
  }]);
  db.seed('family_automation_runs', [{
    id: RUN, family_id: FAMILY, plan_id: PLAN, request_id: REQUEST, run_type: 'concierge', state: 'ready', status: 'pending',
    requested_by_member_id: DANA.member, attempt: 1, max_attempts: 5, lease_owner: 'worker-1', lease_expires_at: '2099-01-01T00:00:00Z',
    run_after: new Date(NOW.getTime() - 60_000).toISOString(), cancel_requested_at: null, paused_at: null, progress: {}, created_by: DANA.user,
  }]);
  // The slice that parks the run on its approval card.
  await runGraphWith(createExecutorPort(client()), RUN, { budgetMs: 60_000 });
  expect(run()).toMatchObject({ state: 'awaiting_approval' });
  expect(db.table('approval_requests')).toHaveLength(1);
  expect(h.executed).toEqual([]);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

/** Put back unexecuted, a day out, with no lease and no attempt spent. */
function expectDeferredADayOut(attemptBefore: unknown): void {
  expect(h.executed).toEqual([]);
  expect(db.table('ai_plan_steps').find((s) => s.id === STEP)?.status).not.toBe('completed');
  expect(run()).toMatchObject({ state: 'ready', lease_owner: null, lease_expires_at: null, attempt: attemptBefore });
  expect(Date.parse(String(run().run_after))).toBeGreaterThanOrEqual(NOW.getTime() + DAY_MS - 60_000);
}

describe('an approval decision', () => {
  it.each(lapses)('does not execute the run of a family %s, and puts it back a day out', async (_label, lapse) => {
    lapse();
    const attemptBefore = run().attempt;

    const decided = await decide(dana(), String(approval().id), 'approved');
    await Promise.all(h.after);

    // The decision itself is recorded: it is the work that waits.
    expect(decided).toMatchObject({ ok: true, data: { status: 'approved' } });
    expect(approval().status).toBe('approved');
    expectDeferredADayOut(attemptBefore);
  });

  it('control: runs the approved step for a family that has Ask Bubaly', async () => {
    const decided = await decide(dana(), String(approval().id), 'approved');
    await Promise.all(h.after);

    expect(decided).toMatchObject({ ok: true, data: { status: 'approved' } });
    expect(h.executed).toEqual(['finances.updateBudget']);
    expect(run().state).toBe('completed');
  });
});

describe('the settled-run sweep (notifications cron)', () => {
  // Decided while the fold failed: the run is still parked on a card that is no longer pending.
  const decidedElsewhere = () => Object.assign(approval(), { status: 'approved', decided_by: DANA.member, decided_at: NOW.toISOString() });

  it.each(lapses)('returns the run to the queue but does not execute it for a family %s', async (_label, lapse) => {
    decidedElsewhere();
    lapse();
    const attemptBefore = run().attempt;

    const swept = await resumeSettledRuns(client(), NOW);
    await Promise.all(h.after);

    expect(swept).toEqual({ resumed: 1, failures: 0 });
    expectDeferredADayOut(attemptBefore);
  });

  it('control: the swept run executes for a family that has Ask Bubaly', async () => {
    decidedElsewhere();

    const swept = await resumeSettledRuns(client(), NOW);
    await Promise.all(h.after);

    expect(swept).toEqual({ resumed: 1, failures: 0 });
    expect(h.executed).toEqual(['finances.updateBudget']);
    expect(run().state).toBe('completed');
  });
});

describe('a kicked run whose family’s plan cannot be read', () => {
  it('is put back now, unexecuted, with no lease and no attempt spent', async () => {
    Object.assign(approval(), { status: 'approved', decided_by: DANA.member, decided_at: NOW.toISOString() });
    Object.assign(run(), { state: 'ready', lease_owner: null, lease_expires_at: null, run_after: NOW.toISOString() });
    const attemptBefore = run().attempt;
    h.db = withFaults(db, (table) => (table === 'subscriptions' ? { message: 'canceling statement due to statement timeout' } : null));

    const result = await continueRun(RUN, { db: client(), budgetMs: 20_000 });

    expect(result).toMatchObject({ claimed: false, completed: 0 });
    expect(h.executed).toEqual([]);
    expect(run()).toMatchObject({ state: 'ready', lease_owner: null, lease_expires_at: null, attempt: attemptBefore });
    expect(Date.parse(String(run().run_after))).toBeLessThanOrEqual(NOW.getTime());
  });
});
