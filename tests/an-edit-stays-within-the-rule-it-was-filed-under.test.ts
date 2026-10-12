// A held request is filed under the rule the family's policies chose for what
// Bubaly asked: here "Under $50, one of us" (single) and "Money needs both of
// us" (two parents) on Bubaly's money changes. The Edit path lets an approver
// change the arguments — the amount included — and then released the edited
// version under the rule the ORIGINAL ask was filed under. So Mum turned a $40
// Groceries card, filed "one of us", into $900 and released it alone, though
// the family's own rule for $900 asks for both parents. The same through the
// run executor: a held $40 step approved with edits ran $900 with the gate
// skipped. An edit written straight to `edited_payload` (any manager may, on a
// pending row) was released by the next plain yes, too.
//
// An edit is now weighed as the gate that filed the request weighed the ask,
// with the edited amount (lib/trust/edit-rule.ts). If it lands under another
// require_approval policy, or a stricter model or count, nothing changes and
// the family asks Bubaly again; edits within the filed rule keep working.
//
// Driven through the real executeTool, trust engine, approvals service, run
// executor port and finance service on the in-memory database.
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

const { executeTool } = await import('@/lib/ai/tools/execute');
const { decide, editAndApprove } = await import('@/lib/services/approvals');
const { createExecutorPort, runGraphWith } = await import('@/lib/ai/runs/executor');
const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');

const FAMILY = '00000000-0000-4000-8000-00000000b401';
const MUM = { member: '00000000-0000-4000-8000-00000000b411', user: '00000000-0000-4000-8000-00000000b421' };
const DAD = { member: '00000000-0000-4000-8000-00000000b412', user: '00000000-0000-4000-8000-00000000b422' };
type Who = typeof MUM | typeof DAD;
const REQUEST = '00000000-0000-4000-8000-00000000b431';
const PLAN = '00000000-0000-4000-8000-00000000b432';
const RUN = '00000000-0000-4000-8000-00000000b433';
const STEP = '00000000-0000-4000-8000-00000000b434';
const DECIDED = '00000000-0000-4000-8000-00000000b435';
const NOW = new Date('2026-09-05T12:00:00Z');

const OUTSIDE = translate(SOURCE_MESSAGES, 'approval.editOutsideFiledRule');
const STEP_OUTSIDE = translate(SOURCE_MESSAGES, 'aiRuns.editOutsideFiledRule');

const policy = <T extends { id: string }>(over: T) => ({
  family_id: FAMILY, domain: 'finances', capability: 'automate', subject_kind: 'ai', subject_role: null, subject_member_id: null,
  effect: 'require_approval', enabled: true, created_at: NOW.toISOString(), updated_at: NOW.toISOString(), ...over,
});
/** "Under $50, one of us." */
const UNDER_FIFTY = policy({
  id: '00000000-0000-4000-8000-00000000b441', name: 'Under $50 one of us',
  conditions: { maxAmountCents: 5000 }, approval_model: 'single', required_approvals: 1, priority: 300,
});
/** "Money needs both of us." */
const BOTH_OF_US = policy({
  id: '00000000-0000-4000-8000-00000000b442', name: 'Money needs both of us',
  conditions: {}, approval_model: 'two_parent', required_approvals: 2, priority: 200,
});

let db: InMemorySupabase;
const client = () => db as unknown as SupabaseClient<Database>;

const assistantFor = (who: Who): ServiceScope => ({
  db: client(), familyId: FAMILY, userId: who.user, memberId: who.member, role: 'parent', actorKind: 'ai', tz: 'America/New_York', now: NOW,
});
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
  db.seed('families', [{ id: FAMILY, name: 'The Riveras', timezone: 'America/New_York' }]);
  db.seed('family_members', [
    { id: MUM.member, family_id: FAMILY, user_id: MUM.user, role: 'parent', is_active: true, display_name: 'Mum' },
    { id: DAD.member, family_id: FAMILY, user_id: DAD.user, role: 'parent', is_active: true, display_name: 'Dad' },
  ]);
  db.seed('family_ai_settings', [{ family_id: FAMILY, enabled: true, behavior: 'execute' }]);
  db.seed('trust_policies', [UNDER_FIFTY, BOTH_OF_US]);
  db.seed('budgets', [{ id: 'budget-groceries', family_id: FAMILY, category: 'Groceries', amount: 400, period: 'monthly', created_at: '2026-01-01T00:00:00Z' }]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

const groceries = () => db.table('budgets').find((b) => b.id === 'budget-groceries')!;
const approvalRow = (id: string) => db.table('approval_requests').find((r) => r.id === id)!;

/** Mum's assistant asks for a Groceries budget; the family's rules hold it for a person. */
async function bubalyAsks(amount: number): Promise<string> {
  const outcome = await executeTool(assistantFor(MUM), 'finances.updateBudget', { category: 'Groceries', amount });
  expect(outcome.status).toBe('pending_approval');
  return (outcome as { approvalId: string }).approvalId;
}

describe('a card Bubaly filed through the tool gate', () => {
  it('files $40 "one of us" and $900 "both of us" — the rules the edit is weighed against', async () => {
    expect(approvalRow(await bubalyAsks(40))).toMatchObject({ approval_model: 'single', required_approvals: 1, policy_id: UNDER_FIFTY.id });
    expect(approvalRow(await bubalyAsks(900))).toMatchObject({ approval_model: 'two_parent', required_approvals: 2, policy_id: BOTH_OF_US.id });
  });

  it('refuses one parent’s edit of the $40 card up to $900, and changes nothing', async () => {
    const card = await bubalyAsks(40);

    const res = await editAndApprove(asParent(MUM), card, { amount: 900 });

    expect(res).toMatchObject({ ok: false, code: 'denied', error: OUTSIDE });
    expect(groceries()).toMatchObject({ amount: 400 });
    expect(approvalRow(card)).toMatchObject({ status: 'pending', edited_payload: null, approvals: [] });
    expect(db.table('ai_tool_calls')).toEqual([]);
  });

  it('refuses a plain yes that would release $900 written straight to the edit column', async () => {
    const card = await bubalyAsks(40);
    const { data, error } = await client().from('approval_requests')
      .update({ edited_payload: { category: 'Groceries', amount: 900 } })
      .eq('id', card).eq('family_id', FAMILY).eq('status', 'pending').select('id');
    expect(error).toBeNull();
    expect(data).toHaveLength(1);

    const res = await decide(asParent(DAD), card, 'approved');

    expect(res).toMatchObject({ ok: false, code: 'denied', error: OUTSIDE });
    expect(groceries()).toMatchObject({ amount: 400 });
    expect(approvalRow(card)).toMatchObject({ status: 'pending', approvals: [] });
  });

  it('still lets an approver correct the amount within the rule it was filed under', async () => {
    const card = await bubalyAsks(40);

    expect(await editAndApprove(asParent(MUM), card, { amount: 45 })).toMatchObject({ ok: true, data: { status: 'modified' } });
    expect(groceries()).toMatchObject({ amount: 45 });
  });

  it('still lets two parents agree an edited amount on a two-parent card', async () => {
    const card = await bubalyAsks(900);

    expect(await editAndApprove(asParent(MUM), card, { amount: 800 })).toMatchObject({ ok: true, data: { status: 'pending' } });
    expect(groceries()).toMatchObject({ amount: 400 });
    expect(await decide(asParent(DAD), card, 'approved')).toMatchObject({ ok: true, data: { status: 'approved', executed: true } });
    expect(groceries()).toMatchObject({ amount: 800 });
  });
});

describe('a step the run executor held', () => {
  function seedRun(step: Record<string, unknown> = {}): void {
    db.seed('ai_requests', [{ id: REQUEST, family_id: FAMILY, requested_by: MUM.user, requested_by_member_id: MUM.member, kind: 'concierge', request_text: 'Set groceries to $40', status: 'executing' }]);
    db.seed('ai_plans', [{ id: PLAN, family_id: FAMILY, request_id: REQUEST, version: 1, status: 'approved', risk_level: 'high' }]);
    db.seed('ai_plan_steps', [{
      id: STEP, family_id: FAMILY, plan_id: PLAN, sequence: 0, step_type: 'act', tool_name: 'finances.updateBudget',
      description: 'Set the Groceries budget', input_json: { category: 'Groceries', amount: 40 }, dependency_ids: [], condition: null,
      status: 'ready', approval_required: true, approval_id: null, risk_level: 'high',
      retry_count: 0, max_retries: 2, result_json: null, error: null, started_at: null, completed_at: null,
      ...step,
    }]);
    db.seed('family_automation_runs', [{
      id: RUN, family_id: FAMILY, plan_id: PLAN, request_id: REQUEST, run_type: 'concierge', state: 'ready',
      status: 'pending', requested_by_member_id: MUM.member, attempt: 1, max_attempts: 5, lease_owner: 'worker-1',
      lease_expires_at: '2099-01-01T00:00:00Z', cancel_requested_at: null, paused_at: null, progress: {}, created_by: MUM.user,
    }]);
  }
  const runOnce = () => runGraphWith(createExecutorPort(client()), RUN, { budgetMs: 60_000 });
  const step = () => db.table('ai_plan_steps').find((s) => s.id === STEP)!;

  it('refuses the edit of a held $40 step up to $900, and the step stays held', async () => {
    seedRun();
    await runOnce();
    expect(step()).toMatchObject({ status: 'awaiting_approval' });
    const card = String(step().approval_id);
    expect(approvalRow(card)).toMatchObject({ payload_kind: 'plan_steps', approval_model: 'single', required_approvals: 1, policy_id: UNDER_FIFTY.id });

    const res = await editAndApprove(asParent(MUM), card, { amount: 900 });

    expect(res).toMatchObject({ ok: false, code: 'denied', error: OUTSIDE });
    expect(approvalRow(card)).toMatchObject({ status: 'pending', edited_payload: null, approvals: [] });
    await runOnce();
    expect(step()).toMatchObject({ status: 'awaiting_approval' });
    expect(groceries()).toMatchObject({ amount: 400 });
  });

  it('does not run an edit decided past its rule before this check existed', async () => {
    // Approved with edits before the change: the row was decided `modified`
    // with $900 on a card filed "one of us", and the step is still parked.
    seedRun({ status: 'awaiting_approval', approval_id: DECIDED });
    db.seed('approval_requests', [{
      id: DECIDED, family_id: FAMILY, domain: 'finances', capability: 'automate', requested_by_kind: 'ai',
      requested_by_member_id: MUM.member, agent: 'concierge', title: 'Set the Groceries budget', summary: null,
      payload: { kind: 'plan_steps', run_id: RUN, step_ids: [STEP], input: { category: 'Groceries', amount: 40 } },
      payload_kind: 'plan_steps', run_id: RUN, request_id: REQUEST, plan_step_id: STEP, plan_step_ids: [STEP],
      approval_model: 'single', required_approvals: 1, policy_id: UNDER_FIFTY.id, confidence: null, priority: 'high',
      consequences: [], status: 'modified', edited_payload: { category: 'Groceries', amount: 900 },
      approvals: [{ member_id: MUM.member, decision: 'approved', note: null, at: NOW.toISOString(), role: 'parent' }],
      decided_by: MUM.member, decided_at: NOW.toISOString(),
    }]);

    await runOnce();

    expect(groceries()).toMatchObject({ amount: 400 });
    expect(step()).toMatchObject({ status: 'failed', error: STEP_OUTSIDE });
    expect(db.table('ai_tool_calls')).toEqual([]);
  });

  it('still runs an edit within the rule the step was filed under', async () => {
    seedRun();
    await runOnce();
    const card = String(step().approval_id);

    expect(await editAndApprove(asParent(MUM), card, { amount: 45 })).toMatchObject({ ok: true, data: { status: 'modified' } });
    await runOnce();

    expect(step()).toMatchObject({ status: 'completed' });
    expect(groceries()).toMatchObject({ amount: 45 });
  });
});
