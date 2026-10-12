// AUD-1028-AI-DENY — a step the plan holds for a person is filed under the
// family's rule for it (`approvalRuleFor` in lib/ai/runs/executor.ts). That
// rule was read for one answer only: a require_approval policy chose the card's
// model and count, and EVERY other answer filed "one of us" with no policy. An
// explicit deny was such an answer. So "Bubaly may spend up to $50" above
// "Bubaly moves no more money than that" refused a bound $900 at the gate, yet
// the same step, held, was filed single, the asker's own yes released it, and
// it ran with the gate skipped (`skipTrust` on an approved step). A deny became
// one person's vote.
//
// A rule that refuses the step outright is the gate's answer whatever the plan
// said: nothing is filed, nothing runs, and the step says why. A step the
// family's rules only hold for a person is filed under that rule as before.
//
// Driven through the real executor port, trust engine, approvals service and
// finance service on the in-memory database.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => holder.db, createServiceClient: () => holder.db }));
vi.mock('@/lib/ai/runs/continue', () => ({
  kickRun: () => {},
  continueRun: async () => ({ status: 'unavailable', completed: 0, failed: 0, pending: 0, awaitingApproval: 0, claimed: false }),
}));

const { decide } = await import('@/lib/services/approvals');
const { createExecutorPort, runGraphWith } = await import('@/lib/ai/runs/executor');
const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');

const FAMILY = '00000000-0000-4000-8000-00000000d101';
const DANA = { member: '00000000-0000-4000-8000-00000000d111', user: '00000000-0000-4000-8000-00000000d121' };
const ALEX = { member: '00000000-0000-4000-8000-00000000d112', user: '00000000-0000-4000-8000-00000000d122' };
type Who = typeof DANA | typeof ALEX;
const REQUEST = '00000000-0000-4000-8000-00000000d131';
const PLAN = '00000000-0000-4000-8000-00000000d132';
const RUN = '00000000-0000-4000-8000-00000000d133';
const COUNT = '00000000-0000-4000-8000-00000000d134';
const BUDGET = '00000000-0000-4000-8000-00000000d135';
const NOW = new Date('2026-09-05T12:00:00Z');

/** What the step says when a family rule refuses it: the engine's own reason, in the reader's language. */
const REFUSED = translate(SOURCE_MESSAGES, 'trust.denyBlockedByPolicy', { domain: translate(SOURCE_MESSAGES, 'trustDomain.finances') });

const policy = <T extends { id: string }>(over: T) => ({
  family_id: FAMILY, domain: 'finances', capability: 'automate', subject_kind: 'ai', subject_role: null, subject_member_id: null,
  enabled: true, created_at: NOW.toISOString(), updated_at: NOW.toISOString(), approval_model: 'single', required_approvals: 1, ...over,
});
/** "Bubaly may spend up to $50." */
const UP_TO_FIFTY = policy({
  id: '00000000-0000-4000-8000-00000000d141', name: 'Bubaly may spend up to $50', effect: 'allow',
  conditions: { maxAmountCents: 5000 }, priority: 300,
});
/** "Bubaly moves no more money than that." */
const NO_MORE = policy({
  id: '00000000-0000-4000-8000-00000000d142', name: 'Bubaly moves no more money than that', effect: 'deny',
  conditions: {}, priority: 200,
});
/** "Money needs both of us." */
const BOTH_OF_US = policy({
  id: '00000000-0000-4000-8000-00000000d143', name: 'Money needs both of us', effect: 'require_approval',
  conditions: {}, approval_model: 'two_parent', required_approvals: 2, priority: 200,
});
/** The Autopilot dial on "off": Bubaly does nothing on its own in scheduling. */
const DIAL_OFF = policy({
  id: '00000000-0000-4000-8000-00000000d144', name: 'Concierge autopilot', domain: 'scheduling', effect: 'deny',
  conditions: {}, priority: 10,
});

let db: InMemorySupabase;
const client = () => db as unknown as SupabaseClient<Database>;
const asParent = (who: Who): ServiceScope => ({
  db: client(), familyId: FAMILY, userId: who.user, memberId: who.member, role: 'parent', actorKind: 'member', tz: 'America/New_York',
});

beforeEach(() => {
  db = createInMemorySupabase({
    uniques: { ai_tool_calls: [['family_id', 'idempotency_key']] },
    defaults: {
      ai_tool_calls: { state: 'reserved', attempt: 1, outputs: null, error: null, finished_at: null },
      approval_requests: { approvals: [], edited_payload: null, plan_step_ids: [], expires_at: '2099-01-01T00:00:00Z' },
    },
  });
  holder.db = db;
  db.seed('families', [{ id: FAMILY, name: 'The Okafors', timezone: 'America/New_York' }]);
  db.seed('family_members', [
    { id: DANA.member, family_id: FAMILY, user_id: DANA.user, role: 'parent', is_active: true, display_name: 'Dana' },
    { id: ALEX.member, family_id: FAMILY, user_id: ALEX.user, role: 'parent', is_active: true, display_name: 'Alex' },
  ]);
  db.seed('family_ai_settings', [{ family_id: FAMILY, enabled: true, behavior: 'execute' }]);
  db.seed('budgets', [{ id: 'budget-groceries', family_id: FAMILY, category: 'Groceries', amount: 400, period: 'monthly', created_at: '2026-01-01T00:00:00Z' }]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

const BOUND = { category: 'Groceries', amount: { $fromStep: COUNT, path: 'count' } };

/**
 * Dana's run: an earlier step that already produced `{ count }`, then the
 * budget step — held (the plan's flag) unless `held` is false.
 */
function seedRun(opts: { count: number; budgetInput?: Record<string, unknown>; held?: boolean; stepType?: string; toolName?: string | null }): void {
  db.seed('ai_requests', [{ id: REQUEST, family_id: FAMILY, requested_by: DANA.user, requested_by_member_id: DANA.member, kind: 'concierge', request_text: 'Set the groceries budget', status: 'executing' }]);
  db.seed('ai_plans', [{ id: PLAN, family_id: FAMILY, request_id: REQUEST, version: 1, status: 'approved', risk_level: 'high' }]);
  const base = {
    family_id: FAMILY, plan_id: PLAN, condition: null, approval_id: null, risk_level: 'high',
    retry_count: 0, max_retries: 2, error: null, started_at: null,
  };
  db.seed('ai_plan_steps', [
    {
      ...base, id: COUNT, sequence: 0, step_type: 'retrieve', tool_name: 'finances.listTransactions', description: 'Add up the month',
      input_json: {}, dependency_ids: [], status: 'completed', approval_required: false,
      result_json: { summary: 'Counted.', count: opts.count }, completed_at: NOW.toISOString(),
    },
    {
      ...base, id: BUDGET, sequence: 1, step_type: opts.stepType ?? 'act',
      tool_name: opts.toolName === undefined ? 'finances.updateBudget' : opts.toolName, description: 'Set the Groceries budget',
      input_json: opts.budgetInput ?? BOUND, dependency_ids: [COUNT], status: 'ready', approval_required: opts.held !== false,
      result_json: null, completed_at: null,
    },
  ]);
  db.seed('family_automation_runs', [{
    id: RUN, family_id: FAMILY, plan_id: PLAN, request_id: REQUEST, run_type: 'concierge', state: 'ready',
    status: 'pending', requested_by_member_id: DANA.member, attempt: 1, max_attempts: 5, lease_owner: 'worker-1',
    lease_expires_at: '2099-01-01T00:00:00Z', cancel_requested_at: null, paused_at: null, progress: {}, created_by: DANA.user,
  }]);
}

const runOnce = () => runGraphWith(createExecutorPort(client()), RUN, { budgetMs: 60_000 });
const budgetStep = () => db.table('ai_plan_steps').find((s) => s.id === BUDGET)!;
const cards = () => db.table('approval_requests');
const card = () => cards().find((r) => r.id === budgetStep().approval_id)!;
const groceries = () => db.table('budgets').find((b) => b.id === 'budget-groceries')!;
const events = () => db.table('ai_run_events').filter((e) => e.step_id === BUDGET).map((e) => e.event_type);

describe('a held step a family rule refuses outright', () => {
  it('a bound $900 the family refuses files no card, runs nothing, and says why', async () => {
    db.seed('trust_policies', [UP_TO_FIFTY, NO_MORE]);
    seedRun({ count: 900 });

    await runOnce();

    expect(cards(), 'a refusal was put to a vote').toEqual([]);
    expect(budgetStep()).toMatchObject({ status: 'failed', approval_id: null, error: REFUSED });
    expect(events()).toContain('step_failed');
    expect(events()).not.toContain('approval_requested');

    // Nothing is waiting, so another pass, or a parent's yes, has nothing to release.
    await runOnce();
    expect(cards()).toEqual([]);
    expect(groceries()).toMatchObject({ amount: 400 });
    expect(db.table('ai_tool_calls'), 'the refused budget change was run').toEqual([]);
  });

  it('a literal $900 under a deny the family wrote after planning files no card either', async () => {
    db.seed('trust_policies', [UP_TO_FIFTY, NO_MORE]);
    seedRun({ count: 0, budgetInput: { category: 'Groceries', amount: 900 } });

    await runOnce();

    expect(cards()).toEqual([]);
    expect(budgetStep()).toMatchObject({ status: 'failed', error: REFUSED });
    expect(groceries()).toMatchObject({ amount: 400 });
    expect(db.table('ai_tool_calls')).toEqual([]);
  });

  it('answers as the gate answers the same step unheld (parity control)', async () => {
    db.seed('trust_policies', [UP_TO_FIFTY, NO_MORE]);
    seedRun({ count: 900, held: false });

    await runOnce();

    expect(cards()).toEqual([]);
    expect(budgetStep()).toMatchObject({ status: 'failed' });
    expect(groceries()).toMatchObject({ amount: 400 });
  });
});

describe('what a refusal does not reach (positive controls)', () => {
  it('a bound $20 the capped allow covers is filed "one of us" and runs on the asker’s yes', async () => {
    db.seed('trust_policies', [UP_TO_FIFTY, NO_MORE]);
    seedRun({ count: 20 });

    await runOnce();
    expect(budgetStep()).toMatchObject({ status: 'awaiting_approval' });
    expect(card()).toMatchObject({ approval_model: 'single', required_approvals: 1, policy_id: null });

    expect(await decide(asParent(DANA), String(card().id), 'approved')).toMatchObject({ ok: true, data: { status: 'approved' } });
    await runOnce();
    expect(budgetStep()).toMatchObject({ status: 'completed' });
    expect(groceries()).toMatchObject({ amount: 20 });
  });

  it('a held step under a require_approval rule is filed with that rule and runs once both parents say yes', async () => {
    db.seed('trust_policies', [UP_TO_FIFTY, BOTH_OF_US]);
    seedRun({ count: 900 });

    await runOnce();
    expect(budgetStep()).toMatchObject({ status: 'awaiting_approval' });
    expect(card()).toMatchObject({ approval_model: 'two_parent', required_approvals: 2, policy_id: BOTH_OF_US.id });

    expect(await decide(asParent(DANA), String(card().id), 'approved')).toMatchObject({ ok: true, data: { status: 'pending', executed: false } });
    await runOnce();
    expect(groceries()).toMatchObject({ amount: 400 });

    expect(await decide(asParent(ALEX), String(card().id), 'approved')).toMatchObject({ ok: true, data: { status: 'approved' } });
    await runOnce();
    expect(budgetStep()).toMatchObject({ status: 'completed' });
    expect(groceries()).toMatchObject({ amount: 900 });
  });

  it('a pure approval step, which runs nothing itself, is still put to the family under the dial’s “off”', async () => {
    db.seed('trust_policies', [DIAL_OFF]);
    seedRun({ count: 0, budgetInput: {}, stepType: 'approval', toolName: null });

    await runOnce();
    expect(budgetStep()).toMatchObject({ status: 'awaiting_approval' });
    expect(cards()).toHaveLength(1);

    expect(await decide(asParent(ALEX), String(card().id), 'approved')).toMatchObject({ ok: true, data: { status: 'approved' } });
    await runOnce();
    expect(budgetStep()).toMatchObject({ status: 'completed' });
  });
});
