// A family that saved "Bubaly · finances → require approval, two parents" meant
// two parents. The planner's dry run saw that policy and held the step — but
// the approval row the executor filed for it carried neither model nor count,
// so the database defaults (`single`, 1) applied: any one manager, the
// requester included, released it, and the step then ran with the gate
// skipped. The family's rule was never evaluated again.
//
// The executor now files a held step's approval under the rule that governs
// that tool for that requester — model, count, policy and the tool's registry
// domain — and `approval_model`/`required_approvals` are frozen once filed
// (0381). Driven through the real executor port and `decide()`.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const hoisted = vi.hoisted(() => ({ db: null as unknown, executed: [] as { name: string; skipTrust: boolean }[] }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => hoisted.db }));
vi.mock('@/lib/ai/runs/continue', () => ({ kickRun: () => {}, continueRun: async () => ({ claimed: false }) }));
vi.mock('@/lib/ai/tools/execute', () => ({
  executeTool: async (_scope: unknown, name: string, _args: unknown, opts: { skipTrust: boolean }) => {
    hoisted.executed.push({ name, skipTrust: opts.skipTrust });
    return { status: 'ok', data: { id: 'budget-1' }, summary: `Did ${name}`, toolCallId: 'call-1', verified: true };
  },
}));

const { createExecutorPort, runGraphWith } = await import('@/lib/ai/runs/executor');
const { decide } = await import('@/lib/services/approvals');
const { dryRunGate } = await import('@/lib/ai/planner/validate');
const { getTool } = await import('@/lib/ai/tools/registry');
const { loadTrustInputs } = await import('@/lib/trust/server');
const { DEFAULT_AI_SETTINGS } = await import('@/lib/ai/family-settings');

const FAMILY = '00000000-0000-4000-8000-00000000fd01';
const DANA = { member: '00000000-0000-4000-8000-00000000de01', user: '00000000-0000-4000-8000-0000000000d1' };
const ALEX = { member: '00000000-0000-4000-8000-00000000de02', user: '00000000-0000-4000-8000-0000000000d2' };
const REQUEST = '00000000-0000-4000-8000-00000000dc01';
const PLAN = '00000000-0000-4000-8000-00000000dc02';
const RUN = '00000000-0000-4000-8000-00000000dc03';
const STEP = '00000000-0000-4000-8000-00000000dc04';
const POLICY = '00000000-0000-4000-8000-00000000dc05';
const NOW = new Date('2026-09-05T12:00:00Z');

let db: InMemorySupabase;
const client = () => db as unknown as SupabaseClient<Database>;

function seed(policies: Record<string, unknown>[]): void {
  db.seed('families', [{ id: FAMILY, name: 'The Riveras', timezone: 'America/New_York' }]);
  db.seed('family_members', [
    { id: DANA.member, family_id: FAMILY, user_id: DANA.user, role: 'parent', is_active: true, display_name: 'Dana' },
    { id: ALEX.member, family_id: FAMILY, user_id: ALEX.user, role: 'parent', is_active: true, display_name: 'Alex' },
  ]);
  db.seed('trust_policies', policies);
  db.seed('ai_requests', [{ id: REQUEST, family_id: FAMILY, requested_by: DANA.user, requested_by_member_id: DANA.member, kind: 'concierge', request_text: 'Raise the grocery budget to $900', status: 'ready' }]);
  db.seed('ai_plans', [{ id: PLAN, family_id: FAMILY, request_id: REQUEST, version: 1, status: 'approved', risk_level: 'high' }]);
  // What the planner saved: the dry run matched the policy and held the step.
  db.seed('ai_plan_steps', [{
    id: STEP, family_id: FAMILY, plan_id: PLAN, sequence: 0, step_type: 'act', tool_name: 'finances.updateBudget', description: 'Raise the grocery budget',
    input_json: { category: 'Groceries', amount: 900 }, dependency_ids: [], condition: null, status: 'queued', approval_required: true, approval_id: null,
    risk_level: 'high', retry_count: 0, max_retries: 2, result_json: null, error: null,
  }]);
  db.seed('family_automation_runs', [{
    id: RUN, family_id: FAMILY, plan_id: PLAN, request_id: REQUEST, run_type: 'concierge', state: 'ready', status: 'pending',
    requested_by_member_id: DANA.member, attempt: 1, max_attempts: 5, lease_owner: 'worker-1', lease_expires_at: '2099-01-01T00:00:00Z',
    cancel_requested_at: null, paused_at: null, progress: {}, created_by: DANA.user,
  }]);
}

const TWO_PARENTS = {
  id: POLICY, family_id: FAMILY, name: 'Money needs both of us', domain: 'finances', capability: 'automate', subject_kind: 'ai',
  effect: 'require_approval', conditions: {}, approval_model: 'two_parent', required_approvals: 2, priority: 200, enabled: true,
  created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
};

const as = (who: typeof DANA): ServiceScope => ({
  db: client(), familyId: FAMILY, userId: who.user, memberId: who.member, role: 'parent', actorKind: 'member', tz: 'America/New_York', now: NOW,
});

beforeEach(() => {
  db = createInMemorySupabase({ defaults: { approval_requests: { approvals: [], edited_payload: null, plan_step_ids: [] } } });
  hoisted.db = db;
  hoisted.executed = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('a planned step held for approval is filed under the family’s own rule', () => {
  it('files the two-parent model, its count, its policy and the tool’s real domain', async () => {
    seed([TWO_PARENTS]);

    await runGraphWith(createExecutorPort(client()), RUN, { budgetMs: 60_000 });

    expect(hoisted.executed).toEqual([]);
    const [row] = db.table('approval_requests');
    expect(row).toMatchObject({
      payload_kind: 'plan_steps', plan_step_id: STEP, requested_by_member_id: DANA.member,
      approval_model: 'two_parent', required_approvals: 2, policy_id: POLICY, domain: 'finances',
    });
  });

  it('is not released by the requester alone — the second parent’s yes is what runs it', async () => {
    seed([TWO_PARENTS]);
    await runGraphWith(createExecutorPort(client()), RUN, { budgetMs: 60_000 });
    const approvalId = String(db.table('approval_requests')[0].id);

    const first = await decide(as(DANA), approvalId, 'approved');
    expect(first).toMatchObject({ ok: true, data: { status: 'pending', executed: false } });
    expect(db.table('ai_plan_steps')[0]).toMatchObject({ status: 'awaiting_approval' });

    const second = await decide(as(ALEX), approvalId, 'approved');
    expect(second).toMatchObject({ ok: true, data: { status: 'approved' } });
    expect(db.table('ai_plan_steps')[0]).toMatchObject({ status: 'ready', approval_required: true });

    db.table('family_automation_runs')[0].state = 'ready';
    await runGraphWith(createExecutorPort(client()), RUN, { budgetMs: 60_000 });
    expect(hoisted.executed).toEqual([{ name: 'finances.updateBudget', skipTrust: true }]);
  });

  it('files an ordinary single approval when no policy asks for more', async () => {
    seed([]);

    await runGraphWith(createExecutorPort(client()), RUN, { budgetMs: 60_000 });

    expect(db.table('approval_requests')[0]).toMatchObject({ approval_model: 'single', required_approvals: 1, policy_id: null, domain: 'finances' });
  });
});

// The Trust form saves a policy with a maximum amount and a priority. "Bubaly
// may spend small amounts" (allow up to $50, priority 300) outranks "Money needs
// both of us" — but only for amounts under $50. The planner's dry run reads the
// step's amount and holds a $900 budget for two parents; the rule the run filed
// the card under read no amount, so the engine took it as 0, the $50 allow
// "matched", and the card went out as one approver's — Dana's own yes ran it.
describe('a rule with an amount condition is read with the step’s amount, as the plan read it', () => {
  const SMALL_AMOUNTS = {
    id: '00000000-0000-4000-8000-00000000dc06', family_id: FAMILY, name: 'Bubaly may spend small amounts', domain: 'finances', capability: 'automate',
    subject_kind: 'ai', effect: 'allow', conditions: { maxAmountCents: 5000 }, approval_model: 'single', required_approvals: 1, priority: 300,
    enabled: true, created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
  };

  async function planTimeDecision(amount: number) {
    const trust = await loadTrustInputs(client(), FAMILY);
    const tool = getTool('finances.updateBudget')!;
    return dryRunGate(tool, { category: 'Groceries', amount }, {
      policies: trust.policies, grants: trust.grants, delegations: trust.delegations, emergencyDomains: trust.emergencyDomains,
      role: 'parent', now: NOW, tz: 'America/New_York', allowedTools: [tool.name], settings: { ...DEFAULT_AI_SETTINGS, familyId: FAMILY },
    } as never, 'execute');
  }

  it('files a $900 budget the plan held for two parents as two parents — the requester alone does not release it', async () => {
    seed([SMALL_AMOUNTS, TWO_PARENTS]);
    expect(await planTimeDecision(900)).toMatchObject({ effect: 'require_approval', approvalModel: 'two_parent', policyId: POLICY });

    await runGraphWith(createExecutorPort(client()), RUN, { budgetMs: 60_000 });

    const [row] = db.table('approval_requests');
    expect(row).toMatchObject({ approval_model: 'two_parent', required_approvals: 2, policy_id: POLICY, domain: 'finances' });
    const first = await decide(as(DANA), String(row.id), 'approved');
    expect(first).toMatchObject({ ok: true, data: { status: 'pending', executed: false } });
    db.table('family_automation_runs')[0].state = 'ready';
    await runGraphWith(createExecutorPort(client()), RUN, { budgetMs: 60_000 });
    expect(hoisted.executed).toEqual([]);
  });

  it('still lets the small-amounts rule speak for an amount under its cap, as the plan does', async () => {
    seed([SMALL_AMOUNTS, TWO_PARENTS]);
    db.table('ai_plan_steps')[0].input_json = { category: 'Groceries', amount: 40 };
    expect(await planTimeDecision(40)).toMatchObject({ effect: 'allow', policyId: SMALL_AMOUNTS.id });

    // Held anyway (the model asked, or a re-plan kept the flag): an ordinary card.
    await runGraphWith(createExecutorPort(client()), RUN, { budgetMs: 60_000 });

    expect(db.table('approval_requests')[0]).toMatchObject({ approval_model: 'single', required_approvals: 1, policy_id: null });
  });
});
