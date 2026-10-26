// "Plans Bubaly ran end to end" — /home's time saved, the billing value cards,
// the autopilot "N things handled" line — counts completed rows in
// family_automation_runs (lib/metric/completed-plans.ts). Each case below is a
// way one plan, or no plan at all, was counted as more:
//
//   N12  re-accepting a plan with the dial on Ask first filed another pending
//        run on the SAME reused approval, and one yes closed them all as
//        completed; a close that applied nothing (every kind already in place)
//        was still recorded as completed; and once the one queued run was
//        dismissed under an expired (not yet swept) approval the trust engine
//        still reuses, a re-accept answered "Waiting for approval" with
//        nothing queued, and then "Decide it in Approvals" for a request that
//        had expired and could no longer be decided;
//   N11  a concierge run closed with an answer, or retired because the cron
//        had already claimed the planner's run, has no plan and was counted;
//   N10  the completions were written through the manager's own session,
//        which the member UPDATE policy cannot be narrowed under while they
//        are — so they go through the server's writer. The session client
//        here refuses a completion, as the owner's pinned policy will.
//        And the server's writer completed whatever named the approval: a
//        manager's own client may INSERT rows naming it (0255/0329), so one
//        yes completed every planted row too. One yes completes the run the
//        server queued (by its idempotency key) and cancels the rest.
//
// Driven through the real concierge actions, the real decide() and the real
// value metric over the in-memory database.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, withFaults, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({
  service: null as unknown, session: null as unknown, ctx: null as unknown,
  trust: { effect: 'allow', approvalId: null as string | null },
}));

vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.session, createServiceClient: () => h.service }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => h.ctx }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/trust/server', () => ({
  roleOf: (role: string) => role,
  evaluateTrust: async () => ({
    decision: { effect: h.trust.effect, basis: 'policy', reason: 'the family dial' },
    approvalId: h.trust.approvalId,
  }),
}));
vi.mock('@/lib/services/ai-settings', () => {
  const settings = {
    familyId: '11111111-1111-4111-8111-111111111111', enabled: true, behavior: 'execute', categoryBehavior: {},
    riskOverrides: {}, childChannels: {}, memoryEnabled: true, quietHours: null,
  };
  return { getAISettings: async () => settings, loadAISettings: async () => ({ ok: true, data: settings }) };
});
vi.mock('@/lib/ai/runs/continue', () => ({
  kickRun: () => {},
  continueRun: async () => ({ status: 'unavailable', completed: 0, failed: 0, pending: 0, awaitingApproval: 0, claimed: false }),
}));

const FAMILY = '11111111-1111-4111-8111-111111111111';
const MUM = '22222222-2222-4222-8222-222222222222';
const PLAN = '55555555-5555-4555-8555-555555555555';
const APPROVAL = '66666666-6666-4666-8666-666666666666';
const RUN = '77777777-7777-4777-8777-777777777777';
const RUN_2 = '88888888-8888-4888-8888-888888888888';
const FILED_PLAN = { title: 'Saturday swim meet', description: 'Drive + snacks', location: 'Aquatic centre', planned_for: '2026-09-12' };

const { planAcceptedAction, executeQueuedRunAction, dismissQueuedRunAction } = await import('@/app/(app)/dashboard/concierge/actions');
const { decide } = await import('@/lib/services/approvals');
const { loadCompletedPlans } = await import('@/lib/metric/completed-plans');

let store: InMemorySupabase;
const runs = () => store.table('family_automation_runs') as Row[];
async function completedPlans(): Promise<number> {
  const result = await loadCompletedPlans(store as unknown as SupabaseClient<Database>, FAMILY, new Date());
  if (!result.available) throw new Error('the value metric reported itself unavailable');
  return result.completedRuns;
}
const scope = (): ServiceScope => ({
  db: h.session as SupabaseClient<Database>, familyId: FAMILY, userId: 'auth-mum', memberId: MUM,
  role: 'parent', actorKind: 'member', tz: 'America/New_York',
});

function seedApproval(extra: Row = {}): void {
  store.seed('approval_requests', [{
    id: APPROVAL, family_id: FAMILY, domain: 'scheduling', capability: 'automate',
    requested_by_kind: 'ai', requested_by_member_id: null, agent: 'Concierge',
    title: 'Materialize: Saturday swim meet', summary: null,
    payload: { plan_id: PLAN, kinds: ['calendar', 'reminder', 'task'], plan: FILED_PLAN },
    payload_kind: 'concierge_plan', amount_cents: null, confidence: 0.9, policy_id: null,
    reasoning: 'risk tier', approval_model: 'single', required_approvals: 1, approvals: [],
    status: 'pending', priority: 'normal', decided_by: null, decided_at: null,
    expires_at: '2099-01-01T00:00:00Z', executed_at: null, execution_result: null,
    request_id: null, run_id: null, plan_step_id: null, plan_step_ids: [],
    consequences: [], evidence: null, edited_payload: null, reviewed_by: null, review_note: null,
    ...extra,
  }]);
  store.seed('trust_audit_logs', [{ family_id: FAMILY, actor_kind: 'ai_agent', actor_id: 'concierge', approval_id: APPROVAL, decision: 'require_approval' }]);
}
function queuedRun(id: string, approvalId: string | null): Row {
  return {
    id, family_id: FAMILY, trigger_type: 'plan_accepted', run_type: 'concierge_plan', status: 'pending',
    state: 'awaiting_approval', requested_by_member_id: MUM, summary: 'Waiting for approval: Materialize: Saturday swim meet', result: {},
    metadata: { plan_id: PLAN, kinds: ['calendar', 'reminder', 'task'], approval_id: approvalId, plan: FILED_PLAN },
    created_by: 'auth-mum', created_at: new Date().toISOString(), completed_at: null,
  };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  store = createInMemorySupabase({ uniques: {
    family_automation_runs: [['family_id', 'idempotency_key']],
    concierge_plan_actions: [['family_id', 'plan_id', 'action_kind']],
  } });
  h.service = store;
  h.session = store;
  h.trust = { effect: 'allow', approvalId: null };
  h.ctx = {
    user: { id: 'auth-mum' },
    active: { familyId: FAMILY, role: 'parent', member: { id: MUM }, family: { id: FAMILY, timezone: 'America/New_York' } },
  };
  store.seed('family_members', [{ id: MUM, family_id: FAMILY, user_id: 'auth-mum', display_name: 'Mum', role: 'parent', is_active: true }]);
  store.seed('concierge_plans', [{
    id: PLAN, family_id: FAMILY, title: 'Saturday swim meet', description: 'Drive + snacks',
    location: 'Aquatic centre', planned_for: '2026-09-12', budget_cents: 2500, status: 'confirmed',
  }]);
});

describe('one plan, accepted more than once, is one completed plan (N12)', () => {
  it('re-accepting on Ask first queues no second run on the same approval, and the yes counts once', async () => {
    h.trust = { effect: 'require_approval', approvalId: APPROVAL };
    expect(await planAcceptedAction(PLAN, 'draft', 'confirmed')).toMatchObject({ ok: true, mode: 'ask' });
    expect(await planAcceptedAction(PLAN, 'draft', 'confirmed')).toMatchObject({ ok: true, mode: 'ask' });
    expect(runs()).toHaveLength(1);

    seedApproval();
    expect(await decide(scope(), APPROVAL, 'approved')).toMatchObject({ ok: true, data: { status: 'approved' } });
    expect(store.table('calendar_events')).toHaveLength(1);
    expect(await completedPlans()).toBe(1);
  });

  it('re-accepting after the queued run was dismissed under an expired approval does not claim it is queued', async () => {
    h.trust = { effect: 'require_approval', approvalId: APPROVAL };
    expect(await planAcceptedAction(PLAN, 'draft', 'confirmed')).toMatchObject({ ok: true, mode: 'ask' });
    // Past its expiry and not yet swept: still 'pending', so the trust engine
    // hands the same approval to the next acceptance, while the panel's
    // Dismiss only clears the run.
    seedApproval({ expires_at: '2026-01-01T00:00:00Z' });
    const [queued] = runs();
    expect(await dismissQueuedRunAction(String(queued.id))).toMatchObject({ ok: true });
    expect(runs()).toEqual([expect.objectContaining({ id: queued.id, status: 'dismissed' })]);

    // And it says so, rather than "Decide it in Approvals": an expired request
    // cannot be decided (openForDecision refuses it, its card is disabled), and
    // only the daily sweep clears it.
    expect(await planAcceptedAction(PLAN, 'draft', 'confirmed')).toEqual({ ok: false, error: 'actions.earlierPlanApprovalExpired' });
    expect(runs().filter((run) => run.status === 'pending')).toHaveLength(0);
  });

  it('an approval still open whose run left the queue another way is the one to decide', async () => {
    h.trust = { effect: 'require_approval', approvalId: APPROVAL };
    expect(await planAcceptedAction(PLAN, 'draft', 'confirmed')).toMatchObject({ ok: true, mode: 'ask' });
    seedApproval();
    // A manager's own UPDATE (0251 pins no column) moves the run off pending
    // while its approval is open and in date: that request can still be decided.
    const [queued] = runs();
    const { data: moved } = await store.from('family_automation_runs')
      .update({ status: 'dismissed', state: 'cancelled' }).eq('family_id', FAMILY).eq('id', String(queued.id)).select('id');
    expect(moved).toHaveLength(1);

    expect(await planAcceptedAction(PLAN, 'draft', 'confirmed')).toEqual({ ok: false, error: 'actions.earlierPlanApprovalStillOpen' });
    expect(runs().filter((run) => run.status === 'pending')).toHaveLength(0);
  });

  it('an earlier approval that could not be read is not described either way', async () => {
    h.trust = { effect: 'require_approval', approvalId: APPROVAL };
    expect(await planAcceptedAction(PLAN, 'draft', 'confirmed')).toMatchObject({ ok: true, mode: 'ask' });
    seedApproval({ expires_at: '2026-01-01T00:00:00Z' });
    const [queued] = runs();
    expect(await dismissQueuedRunAction(String(queued.id))).toMatchObject({ ok: true });

    h.service = withFaults(store, (table) => (table === 'approval_requests' ? { code: 'XX000', message: 'approval read failed' } : null));
    expect(await planAcceptedAction(PLAN, 'draft', 'confirmed')).toEqual({ ok: false, error: 'actions.couldNotQueuePlanForApproval' });
    expect(runs().filter((run) => run.status === 'pending')).toHaveLength(0);
  });

  it('a second never-gated "Do it" on the same plan applies nothing and is not a second completed plan', async () => {
    store.seed('family_automation_runs', [queuedRun(RUN, null), queuedRun(RUN_2, null)]);
    expect(await executeQueuedRunAction(RUN)).toMatchObject({ ok: true, mode: 'auto' });
    expect(await executeQueuedRunAction(RUN_2)).toMatchObject({ ok: true, applied: [] });
    expect(store.table('calendar_events')).toHaveLength(1);
    expect(await completedPlans()).toBe(1);
    expect(runs().find((run) => run.id === RUN_2)).toMatchObject({ state: 'cancelled' });
  });

  it('an approval whose plan was already in place closes its run without counting it again', async () => {
    // Make it happen already materialized the plan and recorded its run.
    expect(await planAcceptedAction(PLAN, 'draft', 'confirmed')).toMatchObject({ ok: true, mode: 'auto' });
    expect(await completedPlans()).toBe(1);
    seedApproval();
    store.seed('family_automation_runs', [queuedRun(RUN, APPROVAL)]);
    expect(await decide(scope(), APPROVAL, 'approved')).toMatchObject({ ok: true });
    expect(await completedPlans()).toBe(1);
    expect(runs().find((run) => run.id === RUN)).toMatchObject({ state: 'cancelled' });
  });

  it('an auto acceptance that lost every kind to a concurrent one records no second completed run', async () => {
    expect(await planAcceptedAction(PLAN, 'draft', 'confirmed')).toMatchObject({ ok: true, mode: 'auto' });
    expect(await completedPlans()).toBe(1);
    // The second acceptance's pre-check saw an empty ledger (it raced the
    // first); the materializer then finds every kind already reserved.
    let ledgerReads = 0;
    h.session = withFaults(store, (table, calls) => (table === 'concierge_plan_actions' && calls[0]?.method === 'select' && ++ledgerReads === 1
      ? { message: 'pre-check raced' } : null));
    expect(await planAcceptedAction(PLAN, 'draft', 'confirmed')).toMatchObject({ ok: true, applied: [] });
    expect(await completedPlans()).toBe(1);
  });
});

describe('one yes completes only the run the server queued for it (N10/N12)', () => {
  // What a manager's own client may INSERT under 0255/0329: state 'queued',
  // status defaulting to 'pending', free metadata, no idempotency key — and
  // what 0251's UPDATE then lets them reshape into a server-looking row.
  const planted = (id: string, extra: Row = {}): Row => ({
    id, family_id: FAMILY, trigger_type: 'plan_accepted', run_type: 'concierge_plan', status: 'pending',
    state: 'queued', requested_by_member_id: null, idempotency_key: null, summary: 'planted', result: {},
    metadata: { plan_id: PLAN, kinds: ['calendar', 'reminder', 'task'], approval_id: APPROVAL, plan: FILED_PLAN },
    created_by: 'auth-mum', created_at: '2026-01-01T00:00:00.000Z', completed_at: null, ...extra,
  });
  const keyed = () => runs().find((run) => run.idempotency_key === `concierge_plan:${PLAN}:${APPROVAL}`);

  it('a yes from the inbox completes the queued run and cancels runs a manager planted naming the approval', async () => {
    h.trust = { effect: 'require_approval', approvalId: APPROVAL };
    expect(await planAcceptedAction(PLAN, 'draft', 'confirmed')).toMatchObject({ ok: true, mode: 'ask' });
    expect(keyed()).toBeDefined();
    store.seed('family_automation_runs', [
      planted('planted-1'), planted('planted-2'),
      // Reshaped to look exactly like the server's own queued row.
      planted('planted-3', { state: 'awaiting_approval', requested_by_member_id: MUM }),
    ]);
    seedApproval();
    expect(await decide(scope(), APPROVAL, 'approved')).toMatchObject({ ok: true, data: { status: 'approved' } });
    expect(await completedPlans()).toBe(1);
    expect(keyed()).toMatchObject({ state: 'completed', status: 'executed' });
    for (const id of ['planted-1', 'planted-2', 'planted-3']) {
      expect(runs().find((run) => run.id === id)).toMatchObject({ state: 'cancelled', status: 'skipped' });
    }
  });

  it('the panel’s approve on a planted row completes the queued run, not the row that was clicked', async () => {
    h.trust = { effect: 'require_approval', approvalId: APPROVAL };
    expect(await planAcceptedAction(PLAN, 'draft', 'confirmed')).toMatchObject({ ok: true, mode: 'ask' });
    // Names the plan only, so decide() has no reason to find it.
    store.seed('family_automation_runs', [planted('clicked', {
      state: 'awaiting_approval', metadata: { plan_id: PLAN, kinds: ['calendar', 'reminder', 'task'], plan: FILED_PLAN },
    })]);
    seedApproval();
    expect(await executeQueuedRunAction('clicked')).toMatchObject({ ok: true, mode: 'auto' });
    expect(store.table('calendar_events')).toHaveLength(1);
    expect(await completedPlans()).toBe(1);
    expect(keyed()).toMatchObject({ state: 'completed' });
    expect(runs().find((run) => run.id === 'clicked')).toMatchObject({ state: 'cancelled', status: 'skipped' });
  });

  it('a close that failed leaves the queued run pending instead of cancelling it with the rest', async () => {
    h.trust = { effect: 'require_approval', approvalId: APPROVAL };
    expect(await planAcceptedAction(PLAN, 'draft', 'confirmed')).toMatchObject({ ok: true, mode: 'ask' });
    store.seed('family_automation_runs', [planted('planted-1')]);
    seedApproval();
    h.service = withFaults(store, (table, calls) => (table === 'family_automation_runs'
      && calls.some((call) => call.method === 'update') && calls.some((call) => call.method === 'eq' && call.args[0] === 'id')
      ? { message: 'run close refused' } : null));
    expect(await decide(scope(), APPROVAL, 'approved')).toMatchObject({ ok: true, data: { status: 'approved', closedRunId: null } });
    expect(keyed()).toMatchObject({ status: 'pending', state: 'awaiting_approval' });
    expect(runs().find((run) => run.id === 'planted-1')).toMatchObject({ status: 'pending' });
    expect(await completedPlans()).toBe(0);
  });

  it('a run queued before the key existed is completed once, and planted rows beside it are cancelled', async () => {
    seedApproval();
    store.seed('family_automation_runs', [
      planted('planted-early'),
      queuedRun(RUN, APPROVAL),
      planted('planted-late', { created_at: '2099-01-01T00:00:00.000Z' }),
    ]);
    expect(await decide(scope(), APPROVAL, 'approved')).toMatchObject({ ok: true, data: { status: 'approved' } });
    expect(await completedPlans()).toBe(1);
    expect(runs().find((run) => run.id === RUN)).toMatchObject({ state: 'completed', status: 'executed' });
    expect(runs().find((run) => run.id === 'planted-early')).toMatchObject({ state: 'cancelled' });
    expect(runs().find((run) => run.id === 'planted-late')).toMatchObject({ state: 'cancelled' });
  });
});

describe('a concierge run with no plan is not a plan Bubaly ran (N11)', () => {
  const closed = (id: string, extra: Row): Row => ({
    id, family_id: FAMILY, state: 'completed', status: 'executed', created_at: new Date().toISOString(),
    completed_at: new Date().toISOString(), ...extra,
  });

  it('does not count an answer after a clarifying question, or the placeholder a claimed planner run retired', async () => {
    store.seed('family_automation_runs', [
      // answerClarification's answer/recommendation close, and adoptPlannedRun's retired placeholder.
      closed('answered', { run_type: 'concierge', trigger_type: 'concierge', plan_id: null, summary: 'Soccer is at 4pm.' }),
      closed('placeholder', { run_type: 'concierge', trigger_type: 'concierge', plan_id: null, summary: 'Answered — Bubaly continued the work in a new run.' }),
      // The planner's run that did the work.
      closed('planned', { run_type: 'concierge', trigger_type: 'concierge', plan_id: '99999999-9999-4999-8999-999999999999' }),
      // The accepted concierge plan's record.
      closed('accepted', { run_type: 'concierge_plan', trigger_type: 'plan_accepted', plan_id: null }),
    ]);
    expect(await completedPlans()).toBe(2);
  });
});

describe('completions are the server’s writes, not the manager’s session (N10)', () => {
  // What the owner's pinned UPDATE policy will refuse a member's own client.
  const sessionRefusingCompletions = () => withFaults(store, (table, calls) => {
    if (table !== 'family_automation_runs') return null;
    const update = calls.find((call) => call.method === 'update')?.args[0] as Row | undefined;
    return update && (update.state === 'completed' || update.status === 'executed' || 'completed_at' in update)
      ? { code: '42501', message: 'a member cannot complete a run' } : null;
  });

  it('the Autopilot panel’s "Do it" still closes the run it applied', async () => {
    store.seed('family_automation_runs', [queuedRun(RUN, null)]);
    h.session = sessionRefusingCompletions();
    expect(await executeQueuedRunAction(RUN)).toMatchObject({ ok: true, mode: 'auto' });
    expect(runs()[0]).toMatchObject({ state: 'completed', status: 'executed' });
    expect(await completedPlans()).toBe(1);
  });

  it('a yes from the approvals inbox still closes the queued run', async () => {
    seedApproval();
    store.seed('family_automation_runs', [queuedRun(RUN, APPROVAL)]);
    h.session = sessionRefusingCompletions();
    expect(await decide(scope(), APPROVAL, 'approved')).toMatchObject({ ok: true, data: { status: 'approved' } });
    expect(runs()[0]).toMatchObject({ state: 'completed', status: 'executed' });
    expect(await completedPlans()).toBe(1);
  });

  it('the panel’s approve, routed through decide(), still closes the run', async () => {
    seedApproval();
    store.seed('family_automation_runs', [queuedRun(RUN, APPROVAL)]);
    h.session = sessionRefusingCompletions();
    expect(await executeQueuedRunAction(RUN)).toMatchObject({ ok: true, mode: 'auto' });
    expect(runs()[0]).toMatchObject({ state: 'completed', status: 'executed' });
    expect(await completedPlans()).toBe(1);
  });
});
