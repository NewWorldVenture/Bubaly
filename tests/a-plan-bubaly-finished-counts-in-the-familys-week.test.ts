// A family on autopilot accepts concierge plans all week. Bubaly puts the events
// on the calendar, sets the reminders and adds the prep tasks — and then, on
// Finances → ?view=manage, in the "Bubaly subscription" block right above the
// change-plan buttons, the "Your family, last 7 days" card said:
//
//     Recorded completed plans   0
//     Modeled planning time      0 min
//     "No plans with a recorded completion date in the last 7 days."
//
// with the dollar comparison beside it at $0.00 and a 0.0x multiple. The same
// card is what the upgrade paywall shows (components/app/upgrade-modal.tsx), so
// a family being asked to pay was shown a zero for work Bubaly had just done.
//
// The cause was one column. `family_automation_runs.completed_at` (0250:197) has
// no default, the only SQL that writes it is the lease recovery in
// claim_ai_runs / reconcile_ai_runs (both `where state = 'executing'`, which a
// concierge row never enters), and all THREE concierge writers left it null:
//
//   app/(app)/dashboard/concierge/actions.ts  autopilot auto-execute (insert)
//   app/(app)/dashboard/concierge/actions.ts  manager taps "Do it" (update)
//   lib/services/approvals/index.ts           the same plan approved from the inbox
//
// The reader (lib/metric/completed-plans.ts) filters the 7-day count on
// `completed_at` and files a null one under `undatedCompletedRuns` — "excluded,
// their week is unknown" — where it stays for all time, because nothing ever
// fills the column in. The last two writers also left `state` at the
// 'awaiting_approval' the row was inserted with while claiming
// `status = 'executed'`, which is separately what the kitchen Display's
// "Handled today" tile filters on.
//
// Every assertion below is on the number the family reads, produced by the real
// metric from rows the real writers wrote.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const db = vi.hoisted(() => ({ client: null as unknown }));
const ctx = vi.hoisted(() => ({ value: null as unknown }));

vi.mock('@/lib/supabase/server', () => ({
  createServer: async () => db.client,
  // The autopilot run ledger reaches for the service role; here it is the same
  // in-memory store, so what it writes is assertable.
  createServiceClient: () => db.client,
}));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => ctx.value }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
// The family's trust policies said yes; that decision is not what is on trial.
vi.mock('@/lib/trust/server', () => ({
  roleOf: (role: string) => role,
  evaluateTrust: async () => ({
    decision: { effect: 'allow', basis: 'policy', reason: 'autopilot is on' },
    approvalId: null,
  }),
}));
vi.mock('@/lib/services/ai-settings', () => ({
  getAISettings: async () => ({
    familyId: FAMILY, enabled: true, behavior: 'execute', categoryBehavior: {},
    riskOverrides: {}, childChannels: {}, memoryEnabled: true, quietHours: null,
  }),
  // The concierge loop reads the switch strictly since SEC-009.
  loadAISettings: async () => ({
    ok: true,
    data: {
      familyId: FAMILY, enabled: true, behavior: 'execute', categoryBehavior: {},
      riskOverrides: {}, childChannels: {}, memoryEnabled: true, quietHours: null,
    },
  }),
}));
vi.mock('@/lib/ai/runs/continue', () => ({
  kickRun: () => {},
  continueRun: async () => ({ status: 'unavailable', completed: 0, failed: 0, pending: 0, awaitingApproval: 0, claimed: false }),
}));

const FAMILY = '11111111-1111-4111-8111-111111111111';
const MUM = '22222222-2222-4222-8222-222222222222';
const PLAN = '55555555-5555-4555-8555-555555555555';
const APPROVAL = '66666666-6666-4666-8666-666666666666';
const RUN = '77777777-7777-4777-8777-777777777777';

const { planAcceptedAction, executeQueuedRunAction } = await import('@/app/(app)/dashboard/concierge/actions');
const { decide } = await import('@/lib/services/approvals');
const { canTransitionRun } = await import('@/lib/ai/runs/states');
const { loadTimeSaved } = await import('@/lib/metric/time-saved-server');

let store: InMemorySupabase;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  store = createInMemorySupabase();
  db.client = store;
  ctx.value = {
    user: { id: 'auth-mum' },
    active: {
      familyId: FAMILY, role: 'parent', member: { id: MUM },
      family: { id: FAMILY, timezone: 'America/New_York' },
    },
  };
  store.seed('family_members', [
    { id: MUM, family_id: FAMILY, user_id: 'auth-mum', display_name: 'Mum', role: 'parent', is_active: true },
  ]);
  store.seed('concierge_plans', [{
    id: PLAN, family_id: FAMILY, title: 'Saturday swim meet', description: 'Drive + snacks',
    location: 'Aquatic centre', planned_for: '2026-09-12', budget_cents: 2500, status: 'confirmed',
  }]);
});

/** What the card on Finances (and on the upgrade paywall) actually renders. */
async function lastSevenDays() {
  const result = await loadTimeSaved(store as unknown as SupabaseClient<Database>, FAMILY, new Date());
  if (!result.available) throw new Error('the value card reported itself unavailable');
  return result.data;
}

function runRow(): Record<string, unknown> {
  const rows = store.table('family_automation_runs') as Record<string, unknown>[];
  expect(rows).toHaveLength(1);
  return rows[0];
}

/** An approval the inbox will close on a single yes. */
function seedQueuedRun(): void {
  store.seed('approval_requests', [{
    id: APPROVAL, family_id: FAMILY, domain: 'scheduling', capability: 'automate',
    requested_by_kind: 'ai', requested_by_member_id: null, agent: 'Concierge',
    title: 'Materialize: Saturday swim meet', summary: null,
    payload: { plan_id: PLAN, kinds: ['calendar', 'reminder', 'task'] },
    payload_kind: 'concierge_plan', amount_cents: null, confidence: 0.9, policy_id: null,
    reasoning: 'risk tier', approval_model: 'single', required_approvals: 1, approvals: [],
    status: 'pending', priority: 'normal', decided_by: null, decided_at: null,
    expires_at: '2099-01-01T00:00:00Z', executed_at: null, execution_result: null,
    request_id: null, run_id: null, plan_step_id: null, plan_step_ids: [],
    consequences: [], evidence: null, edited_payload: null, reviewed_by: null, review_note: null,
  }]);
  store.seed('family_automation_runs', [{
    id: RUN, family_id: FAMILY, trigger_type: 'plan_accepted', status: 'pending',
    state: 'awaiting_approval', requested_by_member_id: MUM,
    summary: 'Waiting for approval: Materialize: Saturday swim meet', result: {},
    metadata: { plan_id: PLAN, kinds: ['calendar', 'reminder', 'task'], approval_id: APPROVAL },
    created_by: 'auth-mum', created_at: new Date().toISOString(), completed_at: null,
  }]);
}

/** The same run with no approval row behind it — the direct "Do it" branch. */
function seedUngatedQueuedRun(): void {
  store.seed('family_automation_runs', [{
    id: RUN, family_id: FAMILY, trigger_type: 'plan_accepted', status: 'pending',
    state: 'awaiting_approval', requested_by_member_id: MUM,
    summary: 'Waiting for approval: Materialize: Saturday swim meet', result: {},
    metadata: { plan_id: PLAN, kinds: ['calendar', 'reminder', 'task'], approval_id: null },
    created_by: 'auth-mum', created_at: new Date().toISOString(), completed_at: null,
  }]);
}

describe('the week the family is shown on Finances', () => {
  it('starts honest: nothing done, nothing claimed, nothing hidden in the excluded line', async () => {
    expect(await lastSevenDays()).toMatchObject({ actions: 0, minutes: 0, undatedCompletedRuns: 0 });
  });

  it('counts a plan autopilot accepted and carried out on its own', async () => {
    const res = await planAcceptedAction(PLAN, 'draft', 'confirmed');
    expect(res).toMatchObject({ ok: true, mode: 'auto' });
    // Bubaly really did the work: the calendar event and the reminders exist.
    expect(store.table('calendar_events')).toHaveLength(1);
    expect((store.table('concierge_plan_actions') as unknown[]).length).toBeGreaterThan(0);

    const week = await lastSevenDays();
    expect(week).toMatchObject({ actions: 1, minutes: 12, undatedCompletedRuns: 0 });
    expect(week.headline).toBe('1 recorded completed plans in the last 7 days — about 12 minutes modeled planning time.');
  });

  it('counts a plan a parent approved with the Autopilot panel’s own button', async () => {
    seedUngatedQueuedRun();

    const res = await executeQueuedRunAction(RUN);
    expect(res).toMatchObject({ ok: true, mode: 'auto' });
    expect(store.table('calendar_events')).toHaveLength(1);

    expect(await lastSevenDays()).toMatchObject({ actions: 1, minutes: 12, undatedCompletedRuns: 0 });
    // The kitchen Display's "Handled today" tile filters `state = 'completed'`,
    // so the run has to agree with itself about being finished.
    expect(runRow()).toMatchObject({ status: 'executed', state: 'completed' });
    expect(runRow().completed_at).toBeTruthy();
  });

  it('counts the same plan approved from the approvals inbox instead', async () => {
    seedQueuedRun();

    // The inbox's own entry point — decideApproval → `decide()` — called
    // directly, so this case reaches runConciergePlan whatever the Autopilot
    // panel's button happens to route through.
    const scope: ServiceScope = {
      db: store as unknown as SupabaseClient<Database>, familyId: FAMILY, userId: 'auth-mum', memberId: MUM,
      role: 'parent', actorKind: 'member', tz: 'America/New_York',
    };
    const res = await decide(scope, APPROVAL, 'approved');
    expect(res).toMatchObject({ ok: true, data: { status: 'approved', executed: true } });
    expect((store.table('approval_requests') as Record<string, unknown>[])[0].status).toBe('approved');
    expect(store.table('calendar_events')).toHaveLength(1);

    expect(await lastSevenDays()).toMatchObject({ actions: 1, minutes: 12, undatedCompletedRuns: 0 });
    expect(runRow()).toMatchObject({ status: 'executed', state: 'completed' });
    expect(runRow().completed_at).toBeTruthy();
  });

  it('counts it when the Autopilot panel’s button decides the approval, too', async () => {
    seedQueuedRun();

    const res = await executeQueuedRunAction(RUN);
    expect(res).toMatchObject({ ok: true, mode: 'auto' });
    expect(await lastSevenDays()).toMatchObject({ actions: 1, minutes: 12, undatedCompletedRuns: 0 });
    expect(runRow()).toMatchObject({ status: 'executed', state: 'completed' });
  });

  it('and the run state machine admits the move these writers make', () => {
    // A concierge row goes straight from waiting to done in one server call;
    // lib/ai/runs/states.ts documents that edge instead of forbidding it.
    expect(canTransitionRun('awaiting_approval', 'completed')).toBe(true);
    expect(canTransitionRun('completed', 'awaiting_approval')).toBe(false);
  });

  it('still refuses to guess a week it was never told — a genuinely undated row stays excluded', async () => {
    // The honest fallback for history written before the writers were fixed.
    // `approved_at` sits in the window and must NOT be read as a completion.
    store.seed('family_automation_runs', [{
      id: RUN, family_id: FAMILY, trigger_type: 'plan_accepted', status: 'executed',
      state: 'completed', created_at: new Date().toISOString(),
      approved_by: 'auth-mum', approved_at: new Date().toISOString(), completed_at: null,
    }]);
    expect(await lastSevenDays()).toMatchObject({ actions: 0, minutes: 0, undatedCompletedRuns: 1 });
  });
});
