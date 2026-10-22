// The Autopilot panel's approve finds the approval that governs a queued plan
// by the plan it names (`governingApprovalFor` in
// app/(app)/dashboard/concierge/actions.ts): the newest pending
// approval_requests row whose payload names that plan_id, decided through
// `decide()`.
//
// It read every row naming the plan, whoever filed it. Any member may file
// their own approval row naming any plan (0255/0480 pin it to
// `requested_by_kind = 'member'`), and `decide()` refuses to run one Bubaly did
// not file. So a guest's planted row took the panel's approve: the first tap
// was refused ("Bubaly did not file this request itself"), and every later tap
// answered "already decided", because the planted row was then approved and
// still the newest. A plan the family's rules had let through (dial on
// "prepare", never gated) could no longer be approved from the panel at all,
// and with a real Bubaly approval pending beside it, the parent's first tap
// went to the planted row instead.
//
// Only rows Bubaly filed govern now. Driven through the real
// planAcceptedAction, executeQueuedRunAction, dismissQueuedRunAction and
// decide() on the in-memory database.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const holder = vi.hoisted(() => ({ db: null as unknown, ctx: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => holder.db, createServiceClient: () => holder.db }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => holder.ctx }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/ai/runs/continue', () => ({
  kickRun: () => {},
  continueRun: async () => ({ status: 'unavailable', completed: 0, failed: 0, pending: 0, awaitingApproval: 0, claimed: false }),
}));

const { planAcceptedAction, executeQueuedRunAction, dismissQueuedRunAction } = await import('@/app/(app)/dashboard/concierge/actions');

const FAMILY = '00000000-0000-4000-8000-00000000b201';
const MUM = { member: '00000000-0000-4000-8000-00000000b211', user: '00000000-0000-4000-8000-00000000b221', role: 'parent' as const };
const DAD = { member: '00000000-0000-4000-8000-00000000b212', user: '00000000-0000-4000-8000-00000000b222', role: 'parent' as const };
const GUEST = { member: '00000000-0000-4000-8000-00000000b214', user: '00000000-0000-4000-8000-00000000b224', role: 'guest' as const };
type Who = typeof MUM | typeof DAD | typeof GUEST;
const PLAN = '00000000-0000-4000-8000-00000000b231';
const PLANTED = '00000000-0000-4000-8000-00000000b241';

let db: InMemorySupabase;

function actAs(who: Who): void {
  holder.ctx = {
    user: { id: who.user, email: `${who.role}@example.test` },
    active: { familyId: FAMILY, role: who.role, member: { id: who.member }, family: { id: FAMILY, timezone: 'America/New_York' } },
  };
}

/** The Concierge dial: allow ("auto") or require_approval ("ask"). */
function dial(effect: 'allow' | 'require_approval'): void {
  db.seed('trust_policies', [{
    id: '00000000-0000-4000-8000-00000000b251', family_id: FAMILY, name: 'Concierge autopilot', domain: 'scheduling',
    capability: 'automate', subject_kind: 'ai', subject_role: null, subject_member_id: null, effect, conditions: {},
    approval_model: 'single', required_approvals: 1, priority: 10, enabled: true, is_system: true,
  }]);
}

/** What a member can file through 0255/0480 by themselves: their own row, naming any plan, newest of all. */
function plantApproval(): void {
  db.seed('approval_requests', [{
    id: PLANTED, family_id: FAMILY, domain: 'scheduling', capability: 'automate', requested_by_kind: 'member',
    requested_by_member_id: GUEST.member, agent: null, title: 'Execute plan: Soccer Saturday', summary: null,
    payload: { plan_id: PLAN, kinds: ['calendar', 'reminder', 'task'] }, payload_kind: null,
    amount_cents: null, confidence: null, policy_id: null, reasoning: null, approval_model: 'single', required_approvals: 1,
    approvals: [], status: 'pending', priority: 'normal', decided_by: null, decided_at: null, expires_at: '2099-01-01T00:00:00Z',
    executed_at: null, execution_result: null, request_id: null, run_id: null, plan_step_id: null, plan_step_ids: [],
    consequences: [], edited_payload: null, reviewed_by: null, review_note: null, created_at: '2099-01-01T00:00:00Z',
  }]);
}

const rows = (table: string) => db.table(table);
const planted = () => rows('approval_requests').find((r) => r.id === PLANTED)!;
const queuedRun = () => {
  const [run] = rows('family_automation_runs');
  expect(run).toBeDefined();
  return run;
};

beforeEach(() => {
  db = createInMemorySupabase({ defaults: { approval_requests: { approvals: [], edited_payload: null, plan_step_ids: [] } } });
  holder.db = db;
  holder.ctx = null;
  db.seed('families', [{ id: FAMILY, name: 'The Riveras', timezone: 'America/New_York' }]);
  db.seed('family_members', [MUM, DAD, GUEST].map((who) => ({
    id: who.member, family_id: FAMILY, user_id: who.user, role: who.role, is_active: true, display_name: who.role,
  })));
  db.seed('concierge_plans', [{
    id: PLAN, family_id: FAMILY, title: 'Soccer Saturday', description: 'At the park', location: 'Riverside Park',
    planned_for: '2026-09-19', budget_cents: null, status: 'booked', created_by: MUM.user,
  }]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('a plan the family let through, queued on "prepare"', () => {
  beforeEach(async () => {
    db.seed('family_ai_settings', [{ family_id: FAMILY, enabled: true, behavior: 'prepare' }]);
    dial('allow');
    actAs(MUM);
    expect(await planAcceptedAction(PLAN, 'planning', 'booked')).toMatchObject({ ok: true, mode: 'ask' });
    // Never gated: the dial asked for a tap, the rules filed no approval.
    expect(rows('approval_requests')).toEqual([]);
    expect(queuedRun()).toMatchObject({ status: 'pending', metadata: { plan_id: PLAN, approval_id: null } });
  });

  it('is approved from the panel although a guest planted a row naming it, and the planted row is left alone', async () => {
    plantApproval();
    actAs(DAD);

    const res = await executeQueuedRunAction(String(queuedRun().id));

    expect(res).toMatchObject({ ok: true, mode: 'auto' });
    expect(rows('calendar_events')).toHaveLength(1);
    expect(rows('calendar_events')[0]).toMatchObject({ title: 'Soccer Saturday', created_by: DAD.user });
    expect(rows('family_reminders')).toHaveLength(2);
    expect(queuedRun()).toMatchObject({ status: 'executed', state: 'completed' });
    // Not decided in Dad's name, and not "approved" with nothing run.
    expect(planted()).toMatchObject({ status: 'pending', approvals: [], decided_by: null });
  });

  it('is dismissed from the panel without declining the planted row in a parent’s name', async () => {
    plantApproval();
    actAs(DAD);

    expect(await dismissQueuedRunAction(String(queuedRun().id))).toEqual({ ok: true, applied: [] });

    expect(queuedRun()).toMatchObject({ status: 'dismissed', state: 'cancelled' });
    expect(planted()).toMatchObject({ status: 'pending', approvals: [], decided_by: null });
    expect(rows('calendar_events')).toEqual([]);
  });
});

describe('a plan Bubaly asked about, with a planted row newer than its card', () => {
  it('the first tap on the panel decides Bubaly’s card and lands the plan', async () => {
    db.seed('family_ai_settings', [{ family_id: FAMILY, enabled: true, behavior: 'execute' }]);
    dial('require_approval');
    actAs(MUM);
    expect(await planAcceptedAction(PLAN, 'planning', 'booked')).toMatchObject({ ok: true, mode: 'ask' });
    const [filed] = rows('approval_requests');
    expect(filed).toMatchObject({ requested_by_kind: 'ai', status: 'pending' });
    plantApproval();
    actAs(DAD);

    const res = await executeQueuedRunAction(String(queuedRun().id));

    expect(res).toMatchObject({ ok: true, mode: 'auto' });
    expect(rows('approval_requests').find((r) => r.id === filed.id)).toMatchObject({ status: 'approved', decided_by: DAD.member });
    expect(rows('calendar_events')).toHaveLength(1);
    expect(queuedRun()).toMatchObject({ status: 'executed', state: 'completed' });
    expect(planted()).toMatchObject({ status: 'pending', approvals: [] });
  });
});
