// A step the plan holds for a person is filed under the family's rule for it
// (`approvalRuleFor` in lib/ai/runs/executor.ts), read with the step's amount.
// That rule was worked out BEFORE the step's bindings were resolved: an amount
// bound from an earlier step (`{ "$fromStep": …, "path": "count" }`) is an
// object, `readAmountCents` read no amount, the engine read 0, and "Bubaly may
// spend up to $50" matched a step that went on to set $900. The row was filed
// "one of us", the person who asked approved it alone, and the step ran $900
// with the gate skipped — while "Money needs both of us" was the family's rule
// for it. A stray `amount_cents` the tool's schema later drops was read ahead
// of the `amount` that actually runs, with the same result.
//
// The rule now reads the amount the tool will run with: bindings resolved
// against the steps it depends on, parsed by the tool's own schema. An amount
// that cannot be read matches no capped rule. Driven through the real executor
// port, trust engine, approvals service and finance service on the in-memory
// database.
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

const FAMILY = '00000000-0000-4000-8000-00000000b501';
const DANA = { member: '00000000-0000-4000-8000-00000000b511', user: '00000000-0000-4000-8000-00000000b521' };
const ALEX = { member: '00000000-0000-4000-8000-00000000b512', user: '00000000-0000-4000-8000-00000000b522' };
type Who = typeof DANA | typeof ALEX;
const REQUEST = '00000000-0000-4000-8000-00000000b531';
const PLAN = '00000000-0000-4000-8000-00000000b532';
const RUN = '00000000-0000-4000-8000-00000000b533';
const COUNT = '00000000-0000-4000-8000-00000000b534';
const BUDGET = '00000000-0000-4000-8000-00000000b535';
const NOW = new Date('2026-09-05T12:00:00Z');

const policy = <T extends { id: string }>(over: T) => ({
  family_id: FAMILY, domain: 'finances', capability: 'automate', subject_kind: 'ai', subject_role: null, subject_member_id: null,
  enabled: true, created_at: NOW.toISOString(), updated_at: NOW.toISOString(), ...over,
});
/** "Bubaly may spend up to $50." */
const UP_TO_FIFTY = policy({
  id: '00000000-0000-4000-8000-00000000b541', name: 'Bubaly may spend up to $50', effect: 'allow',
  conditions: { maxAmountCents: 5000 }, approval_model: 'single', required_approvals: 1, priority: 300,
});
/** "Money needs both of us." */
const BOTH_OF_US = policy({
  id: '00000000-0000-4000-8000-00000000b542', name: 'Money needs both of us', effect: 'require_approval',
  conditions: {}, approval_model: 'two_parent', required_approvals: 2, priority: 200,
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
  db.seed('trust_policies', [UP_TO_FIFTY, BOTH_OF_US]);
  db.seed('budgets', [{ id: 'budget-groceries', family_id: FAMILY, category: 'Groceries', amount: 400, period: 'monthly', created_at: '2026-01-01T00:00:00Z' }]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

/** Dana's run: an earlier step that already produced `{ count: 900 }`, then the held budget step. */
function seedRun(budgetInput: Record<string, unknown>): void {
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
      result_json: { summary: 'Counted.', count: 900 }, completed_at: NOW.toISOString(),
    },
    {
      ...base, id: BUDGET, sequence: 1, step_type: 'act', tool_name: 'finances.updateBudget', description: 'Set the Groceries budget',
      input_json: budgetInput, dependency_ids: [COUNT], status: 'ready', approval_required: true,
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
const card = () => db.table('approval_requests').find((r) => r.id === budgetStep().approval_id)!;
const groceries = () => db.table('budgets').find((b) => b.id === 'budget-groceries')!;

describe('a held step whose amount is bound from an earlier step', () => {
  it('is filed under the family’s rule for the bound $900, so the asker alone does not release it', async () => {
    seedRun({ category: 'Groceries', amount: { $fromStep: COUNT, path: 'count' } });

    await runOnce();

    expect(budgetStep()).toMatchObject({ status: 'awaiting_approval' });
    expect(card()).toMatchObject({ approval_model: 'two_parent', required_approvals: 2, policy_id: BOTH_OF_US.id });

    const first = await decide(asParent(DANA), String(card().id), 'approved');
    expect(first).toMatchObject({ ok: true, data: { status: 'pending', executed: false } });
    await runOnce();
    expect(groceries()).toMatchObject({ amount: 400 });

    // The second parent's yes is what releases it, and it runs as bound.
    expect(await decide(asParent(ALEX), String(card().id), 'approved')).toMatchObject({ ok: true, data: { status: 'approved' } });
    await runOnce();
    expect(budgetStep()).toMatchObject({ status: 'completed' });
    expect(groceries()).toMatchObject({ amount: 900 });
  });

  it('is filed under no capped rule when the bound amount cannot be read', async () => {
    seedRun({ category: 'Groceries', amount: { $fromStep: COUNT, path: 'total' } });

    await runOnce();

    expect(card()).toMatchObject({ approval_model: 'two_parent', required_approvals: 2, policy_id: BOTH_OF_US.id });
  });
});

describe('a held step whose arguments carry a key the tool drops', () => {
  it('is filed by the amount the tool will run, not a stray amount_cents ahead of it', async () => {
    seedRun({ category: 'Groceries', amount: 900, amount_cents: 100 });

    await runOnce();

    expect(card()).toMatchObject({ approval_model: 'two_parent', required_approvals: 2, policy_id: BOTH_OF_US.id });
  });
});

describe('a held step the capped rule really covers (not over-tightened)', () => {
  it('a $20 step is filed "one of us" and the asker’s own yes releases it', async () => {
    seedRun({ category: 'Groceries', amount: 20 });

    await runOnce();
    expect(card()).toMatchObject({ approval_model: 'single', required_approvals: 1 });

    expect(await decide(asParent(DANA), String(card().id), 'approved')).toMatchObject({ ok: true, data: { status: 'approved' } });
    await runOnce();
    expect(groceries()).toMatchObject({ amount: 20 });
  });
});
