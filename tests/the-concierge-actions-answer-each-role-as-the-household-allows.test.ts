// The five concierge actions (app/(app)/dashboard/concierge/actions.ts), each
// called with VALID input by every role of household A, and with household B's
// ids, through the real exported functions. The trust engine, the AI settings
// read and the approvals service run for real against the in-memory tables;
// only the session (requireUserContext), the clients and the request are stubbed.
//
// THE POLICY THESE PIN, from the sources rather than the action:
//   - The autopilot panel's three controls — the dial, Approve and Dismiss — are
//     a manager's: components/concierge/autopilot-panel.tsx renders them for
//     `isManager(role)` only, trust_policies is written by parent/adult only
//     (0093 `trust_policies_write`), and family_automation_runs is updated by a
//     manager only (0251 `family_automation_runs_update`, can_manage_family).
//   - "Make it happen" and accepting a plan are a member's: the plan card and
//     its write-back buttons render for every member who can open the page
//     (components/modules/concierge-module.tsx, plan-write-backs.tsx), and the
//     tables they write let any member insert (0158 concierge_plan_actions,
//     0479 family_reminders, 01050 calendar_events). A teen and a caregiver are
//     pinned as writers here. A child and a guest are NOT pinned: see the PR
//     body ("Defects found" for the guest, "Needs an owner decision" for a child).
//   - Every id is read inside the caller's own family, so household B's plan or
//     run is "not found" to household A and nothing in either household moves.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { LOCALE_COOKIE } from '@/lib/i18n/locales';

const holder = vi.hoisted(() => ({ db: null as unknown, ctx: null as unknown, signedOut: false }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => holder.db, createServiceClient: () => holder.db }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => {
    // requireUserContext sends a signed-out caller to /login by throwing.
    if (holder.signedOut) throw new Error('NEXT_REDIRECT:/login');
    return holder.ctx;
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (name === LOCALE_COOKIE ? { value: 'en-US' } : undefined) }),
  headers: async () => new Headers(),
}));
vi.mock('@/lib/ai/runs/continue', () => ({
  kickRun: () => {},
  continueRun: async () => ({ status: 'unavailable', completed: 0, failed: 0, pending: 0, awaitingApproval: 0, claimed: false }),
}));

const {
  applyConciergePlanAction, dismissQueuedRunAction, executeQueuedRunAction, planAcceptedAction, setConciergeAutopilotAction,
} = await import('@/app/(app)/dashboard/concierge/actions');

// ── The English a member reads (lib/i18n/messages/en-US.json), typed out ──────
const ONLY_MANAGERS_APPROVE = 'Only parents/guardians can approve';
const ONLY_MANAGERS_DECLINE = 'Only parents/guardians can decline';
const ONLY_MANAGERS_DIAL = 'Only parents/guardians can change autopilot';
const RUN_NOT_FOUND = 'Run not found or already handled';
const PLAN_NOT_FOUND = 'Plan not found';
const INVALID_LEVEL = 'Invalid level';

// ── Two households ────────────────────────────────────────────────────────────
const A = '00000000-0000-4000-8000-0000000c0a01';
const B = '00000000-0000-4000-8000-0000000c0b01';

type Role = 'parent' | 'adult' | 'teen' | 'child' | 'caregiver' | 'guest';
type Who = { member: string; user: string; role: Role; email: string; family: string };

const memberOf = (family: string, n: number, role: Role, email = `${role}@example.com`): Who => ({
  member: `00000000-0000-4000-8000-0000000c${family === A ? 'a' : 'b'}1${n}`,
  user: `00000000-0000-4000-8000-0000000c${family === A ? 'a' : 'b'}2${n}`,
  role, email, family,
});

const IN_A: Record<Role, Who> = {
  parent: memberOf(A, 1, 'parent'),
  adult: memberOf(A, 2, 'adult'),
  teen: memberOf(A, 3, 'teen'),
  child: memberOf(A, 4, 'child'),
  caregiver: memberOf(A, 5, 'caregiver'),
  guest: memberOf(A, 6, 'guest'),
};
// A child signed in with their PIN: the same `child` row, a synthetic address
// (lib/onboarding/child-login.ts).
const KID_LOGIN: Who = { ...IN_A.child, email: 'child.mia@kids.bubaly.app' };
const B_PARENT = memberOf(B, 1, 'parent');

const PLAN_A = '00000000-0000-4000-8000-0000000c0a31';
const PLAN_B = '00000000-0000-4000-8000-0000000c0b31';
const POLICY_A = '00000000-0000-4000-8000-0000000c0a41';
const POLICY_B = '00000000-0000-4000-8000-0000000c0b41';
const RUN_B = '00000000-0000-4000-8000-0000000c0b51';

const MANAGERS = ['parent', 'adult'] as const;
const NON_MANAGERS: Who[] = [IN_A.teen, IN_A.child, KID_LOGIN, IN_A.caregiver, IN_A.guest];
// Pinned as plan writers (see the header); child and guest are reported, not pinned.
const PLAN_WRITERS = ['parent', 'adult', 'teen', 'caregiver'] as const;

let db: InMemorySupabase;

function actAs(who: Who): void {
  holder.signedOut = false;
  holder.ctx = {
    user: { id: who.user, email: who.email },
    memberships: [],
    active: {
      familyId: who.family, role: who.role, member: { id: who.member },
      family: { id: who.family, timezone: 'America/New_York' },
    },
  };
}

function signedOut(): void {
  holder.signedOut = true;
  holder.ctx = null;
}

/** Every table any of the five actions can write, as it stands now. */
const TABLES = [
  'trust_policies', 'family_automation_runs', 'approval_requests', 'concierge_plan_actions',
  'calendar_events', 'family_reminders', 'concierge_plans', 'trust_audit_logs',
] as const;
const snapshot = () => structuredClone(Object.fromEntries(TABLES.map((t) => [t, db.table(t)])));
const rowsOf = (table: string, family: string) => db.table(table).filter((r) => r.family_id === family);

/** The family's autopilot dial and its Bubaly settings, as 0093/0257 store them. */
function dial(family: string, policyId: string, effect: 'allow' | 'require_approval', behavior: 'execute' | 'prepare'): void {
  db.seed('family_ai_settings', [{ family_id: family, enabled: true, behavior }]);
  db.seed('trust_policies', [{
    id: policyId, family_id: family, name: 'Concierge autopilot', domain: 'scheduling', capability: 'automate',
    subject_kind: 'ai', subject_role: null, subject_member_id: null, effect, conditions: {},
    approval_model: 'single', required_approvals: 1, priority: 10, enabled: true, is_system: true,
  }]);
}

/** A family member accepts household A's plan (planning → booked), the way the plan card does. */
async function acceptPlanA(who: Who) {
  db.replace('concierge_plans', db.table('concierge_plans').map((p) => (p.id === PLAN_A ? { ...p, status: 'booked' } : p)));
  actAs(who);
  return planAcceptedAction(PLAN_A, 'planning', 'booked');
}

/** A pending run in household A, queued by the parent's acceptance with the dial on "prepare" (never gated). */
async function queuedNeverGatedRunInA(): Promise<Row> {
  dial(A, POLICY_A, 'allow', 'prepare');
  expect(await acceptPlanA(IN_A.parent)).toMatchObject({ ok: true, mode: 'ask' });
  const runs = rowsOf('family_automation_runs', A);
  expect(runs).toHaveLength(1);
  expect(rowsOf('approval_requests', A)).toEqual([]);
  return runs[0];
}

/** A pending run in household A gated by Bubaly's own approval card (dial on "ask"). */
async function queuedGatedRunInA(): Promise<{ run: Row; approval: Row }> {
  dial(A, POLICY_A, 'require_approval', 'execute');
  expect(await acceptPlanA(IN_A.parent)).toMatchObject({ ok: true, mode: 'ask' });
  const [run] = rowsOf('family_automation_runs', A);
  const [approval] = rowsOf('approval_requests', A);
  expect(run).toMatchObject({ status: 'pending', state: 'awaiting_approval' });
  expect(approval).toMatchObject({ status: 'pending', requested_by_kind: 'ai', payload: { plan_id: PLAN_A } });
  return { run, approval };
}

beforeEach(() => {
  db = createInMemorySupabase({ defaults: { approval_requests: { approvals: [], edited_payload: null, plan_step_ids: [] } } });
  holder.db = db;
  holder.ctx = null;
  holder.signedOut = false;
  db.seed('families', [
    { id: A, name: 'Household A', timezone: 'America/New_York' },
    { id: B, name: 'Household B', timezone: 'America/New_York' },
  ]);
  db.seed('family_members', [...Object.values(IN_A), B_PARENT].map((who) => ({
    id: who.member, family_id: who.family, user_id: who.user, role: who.role, is_active: true, display_name: who.role,
  })));
  db.seed('concierge_plans', [
    {
      id: PLAN_A, family_id: A, title: 'Soccer Saturday', description: 'At the park', location: 'Riverside Park',
      planned_for: '2026-12-19', budget_cents: null, status: 'planning', created_by: IN_A.parent.user,
    },
    {
      id: PLAN_B, family_id: B, title: 'Museum Sunday', description: 'Dinosaurs', location: 'City Museum',
      planned_for: '2026-12-20', budget_cents: null, status: 'booked', created_by: B_PARENT.user,
    },
  ]);
  // Household B's own autopilot dial and a run waiting on its own panel.
  dial(B, POLICY_B, 'require_approval', 'execute');
  db.seed('family_automation_runs', [{
    id: RUN_B, family_id: B, trigger_type: 'plan_accepted', status: 'pending', state: 'awaiting_approval',
    requested_by_member_id: B_PARENT.member, summary: 'Waiting for approval: Museum Sunday', result: {},
    metadata: { plan_id: PLAN_B, kinds: ['calendar', 'reminder'], approval_id: null, plan: { title: 'Museum Sunday', description: 'Dinosaurs', location: 'City Museum', planned_for: '2026-12-20' } },
    created_by: B_PARENT.user,
  }]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

// ─── setConciergeAutopilotAction ─────────────────────────────────────────────
describe('setConciergeAutopilotAction: the autopilot dial is a manager’s', () => {
  it.each(MANAGERS)('ACTION-A6BF2165755D a %s sets the dial: one live system policy, moved in place on the next save', async (role) => {
    const who = IN_A[role];
    actAs(who);
    expect(await setConciergeAutopilotAction('ask')).toEqual({ ok: true, applied: [] });

    const [created, ...others] = rowsOf('trust_policies', A);
    expect(others).toEqual([]);
    expect(created).toMatchObject({
      name: 'Concierge autopilot', domain: 'scheduling', capability: 'automate', subject_kind: 'ai',
      effect: 'require_approval', enabled: true, is_system: true, priority: 10, created_by: who.user,
    });

    expect(await setConciergeAutopilotAction('auto')).toEqual({ ok: true, applied: [] });
    expect(rowsOf('trust_policies', A)).toEqual([{ ...created, effect: 'allow' }]);
  });

  it.each(NON_MANAGERS.map((w) => [w.email, w] as const))(
    'ACTION-A6BF2165755D %s is refused and no policy is written', async (_label, who) => {
      dial(A, POLICY_A, 'require_approval', 'execute');
      const before = snapshot();
      actAs(who);
      expect(await setConciergeAutopilotAction('auto')).toEqual({ ok: false, error: ONLY_MANAGERS_DIAL });
      expect(snapshot()).toEqual(before);
      expect(rowsOf('trust_policies', A)).toEqual([expect.objectContaining({ id: POLICY_A, effect: 'require_approval' })]);
    },
  );

  it('ACTION-A6BF2165755D a parent’s save moves only their own household’s dial, never another family’s', async () => {
    dial(A, POLICY_A, 'require_approval', 'execute');
    const bBefore = structuredClone(rowsOf('trust_policies', B));
    actAs(IN_A.parent);
    expect(await setConciergeAutopilotAction('off')).toEqual({ ok: true, applied: [] });
    expect(rowsOf('trust_policies', A)).toEqual([expect.objectContaining({ id: POLICY_A, effect: 'deny' })]);
    expect(rowsOf('trust_policies', B)).toEqual(bBefore);
  });

  it('ACTION-A6BF2165755D a level the dial does not offer is refused before anything is read', async () => {
    const before = snapshot();
    actAs(IN_A.parent);
    expect(await setConciergeAutopilotAction('always' as never)).toEqual({ ok: false, error: INVALID_LEVEL });
    expect(snapshot()).toEqual(before);
  });

  it('ACTION-A6BF2165755D a signed-out caller is sent to sign in and nothing is written', async () => {
    const before = snapshot();
    signedOut();
    await expect(setConciergeAutopilotAction('auto')).rejects.toThrow('NEXT_REDIRECT:/login');
    expect(snapshot()).toEqual(before);
  });
});

// ─── executeQueuedRunAction ──────────────────────────────────────────────────
describe('executeQueuedRunAction: approving a queued run is a manager’s', () => {
  it.each(MANAGERS)('ACTION-AAF8BA72C390 a %s approves a never-gated run: the plan lands once and the run completes', async (role) => {
    const run = await queuedNeverGatedRunInA();
    const who = IN_A[role];
    actAs(who);

    expect(await executeQueuedRunAction(String(run.id))).toMatchObject({ ok: true, mode: 'auto', applied: ['calendar', 'reminder', 'task'] });

    expect(rowsOf('calendar_events', A)).toEqual([expect.objectContaining({ title: 'Soccer Saturday', created_by: who.user, all_day: true })]);
    expect(rowsOf('family_reminders', A).map((r) => r.title).sort()).toEqual(['Follow up: Soccer Saturday', 'Prep: Soccer Saturday']);
    expect(rowsOf('concierge_plan_actions', A).map((r) => r.action_kind).sort()).toEqual(['calendar', 'reminder', 'task']);
    expect(rowsOf('family_automation_runs', A)).toEqual([expect.objectContaining({
      id: run.id, state: 'completed', approved_by: who.user,
    })]);
    expect(rowsOf('family_automation_runs', A)[0].completed_at).toEqual(expect.any(String));
  });

  it.each(NON_MANAGERS.map((w) => [w.email, w] as const))(
    'ACTION-AAF8BA72C390 %s is refused, nothing is materialised and the run stays queued', async (_label, who) => {
      const run = await queuedNeverGatedRunInA();
      const before = snapshot();
      actAs(who);
      expect(await executeQueuedRunAction(String(run.id))).toEqual({ ok: false, error: ONLY_MANAGERS_APPROVE });
      expect(snapshot()).toEqual(before);
      expect(rowsOf('calendar_events', A)).toEqual([]);
      expect(rowsOf('family_automation_runs', A)).toEqual([expect.objectContaining({ id: run.id, status: 'pending', state: 'awaiting_approval' })]);
    },
  );

  it('ACTION-AAF8BA72C390 a parent of household A cannot approve household B’s run', async () => {
    const before = snapshot();
    actAs(IN_A.parent);
    expect(await executeQueuedRunAction(RUN_B)).toEqual({ ok: false, error: RUN_NOT_FOUND });
    expect(snapshot()).toEqual(before);
    expect(rowsOf('family_automation_runs', B)).toEqual([expect.objectContaining({ id: RUN_B, status: 'pending' })]);
    expect(rowsOf('calendar_events', B)).toEqual([]);
  });

  it('ACTION-AAF8BA72C390 a signed-out caller is sent to sign in and nothing is written', async () => {
    const run = await queuedNeverGatedRunInA();
    const before = snapshot();
    signedOut();
    await expect(executeQueuedRunAction(String(run.id))).rejects.toThrow('NEXT_REDIRECT:/login');
    expect(snapshot()).toEqual(before);
  });
});

// ─── dismissQueuedRunAction ──────────────────────────────────────────────────
describe('dismissQueuedRunAction: dismissing a queued run is a manager’s', () => {
  it.each(MANAGERS)('ACTION-BB7CCC59F13B a %s dismisses a gated run: the card is declined and the run is cancelled', async (role) => {
    const { run, approval } = await queuedGatedRunInA();
    actAs(IN_A[role]);

    expect(await dismissQueuedRunAction(String(run.id))).toEqual({ ok: true, applied: [] });

    expect(rowsOf('family_automation_runs', A)).toEqual([expect.objectContaining({ id: run.id, status: 'dismissed', state: 'cancelled' })]);
    expect(rowsOf('approval_requests', A)).toEqual([expect.objectContaining({ id: approval.id, status: 'rejected', decided_by: IN_A[role].member })]);
    expect(rowsOf('calendar_events', A)).toEqual([]);
    expect(rowsOf('family_reminders', A)).toEqual([]);
  });

  it.each(NON_MANAGERS.map((w) => [w.email, w] as const))(
    'ACTION-BB7CCC59F13B %s is refused and neither the run nor its card moves', async (_label, who) => {
      const { run } = await queuedGatedRunInA();
      const before = snapshot();
      actAs(who);
      expect(await dismissQueuedRunAction(String(run.id))).toEqual({ ok: false, error: ONLY_MANAGERS_DECLINE });
      expect(snapshot()).toEqual(before);
      expect(rowsOf('approval_requests', A)).toEqual([expect.objectContaining({ status: 'pending' })]);
    },
  );

  it('ACTION-BB7CCC59F13B a parent of household A cannot dismiss household B’s run', async () => {
    const before = snapshot();
    actAs(IN_A.parent);
    expect(await dismissQueuedRunAction(RUN_B)).toEqual({ ok: false, error: RUN_NOT_FOUND });
    expect(snapshot()).toEqual(before);
    expect(rowsOf('family_automation_runs', B)).toEqual([expect.objectContaining({ id: RUN_B, status: 'pending', state: 'awaiting_approval' })]);
  });

  it('ACTION-BB7CCC59F13B a signed-out caller is sent to sign in and nothing is written', async () => {
    const { run } = await queuedGatedRunInA();
    const before = snapshot();
    signedOut();
    await expect(dismissQueuedRunAction(String(run.id))).rejects.toThrow('NEXT_REDIRECT:/login');
    expect(snapshot()).toEqual(before);
  });
});

// ─── applyConciergePlanAction ────────────────────────────────────────────────
describe('applyConciergePlanAction: "Make it happen" writes the plan into the caller’s household', () => {
  it.each(PLAN_WRITERS)('ACTION-868185556319 a %s applies the plan: one event, one reminder, one ledger row each, under their name', async (role) => {
    const who = IN_A[role];
    actAs(who);

    expect(await applyConciergePlanAction(PLAN_A, ['calendar', 'reminder'])).toEqual({ ok: true, applied: ['calendar', 'reminder'] });

    expect(rowsOf('calendar_events', A)).toEqual([expect.objectContaining({
      title: 'Soccer Saturday', created_by: who.user, location: 'Riverside Park', all_day: true,
    })]);
    expect(rowsOf('family_reminders', A)).toEqual([expect.objectContaining({
      title: 'Follow up: Soccer Saturday', created_by: who.user, kind: 'reminder',
    })]);
    expect(rowsOf('concierge_plan_actions', A).map((r) => [r.action_kind, r.created_by]).sort()).toEqual([
      ['calendar', who.user], ['reminder', who.user],
    ]);
    // A second tap is the same plan: nothing is written twice.
    expect(await applyConciergePlanAction(PLAN_A, ['calendar', 'reminder'])).toEqual({ ok: true, applied: [] });
    expect(rowsOf('calendar_events', A)).toHaveLength(1);
    expect(rowsOf('family_reminders', A)).toHaveLength(1);
  });

  it('ACTION-868185556319 a parent of household A cannot apply household B’s plan, into either household', async () => {
    const before = snapshot();
    actAs(IN_A.parent);
    expect(await applyConciergePlanAction(PLAN_B, ['calendar', 'reminder', 'task'])).toEqual({ ok: false, error: PLAN_NOT_FOUND });
    expect(snapshot()).toEqual(before);
    expect(db.table('calendar_events')).toEqual([]);
    expect(db.table('concierge_plan_actions')).toEqual([]);
  });

  it('ACTION-868185556319 a signed-out caller is sent to sign in and nothing is written', async () => {
    const before = snapshot();
    signedOut();
    await expect(applyConciergePlanAction(PLAN_A, ['calendar'])).rejects.toThrow('NEXT_REDIRECT:/login');
    expect(snapshot()).toEqual(before);
  });
});

// ─── planAcceptedAction ──────────────────────────────────────────────────────
describe('planAcceptedAction: accepting a plan asks Bubaly to act in the caller’s household', () => {
  it.each(PLAN_WRITERS)('ACTION-A29C7E5C3F79 a %s accepts with the dial on "ask": one approval card for the parents and one queued run, nothing materialised', async (role) => {
    dial(A, POLICY_A, 'require_approval', 'execute');
    const who = IN_A[role];

    expect(await acceptPlanA(who)).toMatchObject({ ok: true, mode: 'ask', applied: [] });

    expect(rowsOf('approval_requests', A)).toEqual([expect.objectContaining({
      status: 'pending', requested_by_kind: 'ai', domain: 'scheduling', capability: 'automate',
      payload: expect.objectContaining({ plan_id: PLAN_A }),
    })]);
    expect(rowsOf('family_automation_runs', A)).toEqual([expect.objectContaining({
      status: 'pending', state: 'awaiting_approval', requested_by_member_id: who.member, created_by: who.user,
      metadata: expect.objectContaining({ plan_id: PLAN_A }),
    })]);
    expect(rowsOf('calendar_events', A)).toEqual([]);
    expect(rowsOf('family_reminders', A)).toEqual([]);
  });

  it.each(MANAGERS)('ACTION-A29C7E5C3F79 a %s accepts with the dial on "auto": the plan lands and a completed run records it', async (role) => {
    dial(A, POLICY_A, 'allow', 'execute');
    const who = IN_A[role];

    expect(await acceptPlanA(who)).toMatchObject({ ok: true, mode: 'auto', applied: ['calendar', 'reminder', 'task'] });

    expect(rowsOf('calendar_events', A)).toEqual([expect.objectContaining({ title: 'Soccer Saturday', created_by: who.user })]);
    expect(rowsOf('family_reminders', A)).toHaveLength(2);
    expect(rowsOf('family_automation_runs', A)).toEqual([expect.objectContaining({
      state: 'completed', requested_by_member_id: who.member, trigger_type: 'plan_accepted',
    })]);
    expect(rowsOf('approval_requests', A)).toEqual([]);
  });

  // The dial speaks for the managers: an allow addressed to Bubaly does not
  // reach an assistant acting for a role that is not automation-trusted
  // (lib/trust/engine.ts allowReachesAssistant, ROLE_DEFAULTS), so the engine
  // answers from the role matrix and Bubaly does nothing on its own.
  it.each(NON_MANAGERS.map((w) => [w.email, w] as const))(
    'ACTION-A29C7E5C3F79 %s accepts with the dial on "auto": Bubaly does not act for them, nothing is written', async (_label, who) => {
      dial(A, POLICY_A, 'allow', 'execute');
      db.replace('concierge_plans', db.table('concierge_plans').map((p) => (p.id === PLAN_A ? { ...p, status: 'booked' } : p)));
      const before = snapshot();
      actAs(who);
      expect(await planAcceptedAction(PLAN_A, 'planning', 'booked')).toEqual({ ok: true, mode: 'off', applied: [], summary: null });
      // Only the engine's own explanation row is new.
      const { trust_audit_logs: auditBefore, ...householdBefore } = before;
      const { trust_audit_logs: auditAfter, ...householdAfter } = snapshot();
      expect(householdAfter).toEqual(householdBefore);
      expect(auditAfter).toHaveLength(auditBefore.length + 1);
      expect(rowsOf('trust_audit_logs', A)).toEqual([expect.objectContaining({ decision: 'deny', actor_kind: 'ai_agent' })]);
    },
  );

  it('ACTION-A29C7E5C3F79 a parent of household A cannot set Bubaly to work on household B’s plan', async () => {
    dial(A, POLICY_A, 'allow', 'execute');
    const before = snapshot();
    actAs(IN_A.parent);
    expect(await planAcceptedAction(PLAN_B, 'planning', 'booked')).toEqual({ ok: false, error: PLAN_NOT_FOUND });
    expect(snapshot()).toEqual(before);
    expect(db.table('calendar_events')).toEqual([]);
    expect(rowsOf('family_automation_runs', A)).toEqual([]);
    expect(rowsOf('family_automation_runs', B)).toEqual([expect.objectContaining({ id: RUN_B })]);
  });

  it('ACTION-A29C7E5C3F79 an acceptance the plan row does not show materialises nothing', async () => {
    dial(A, POLICY_A, 'allow', 'execute');
    const before = snapshot();
    actAs(IN_A.parent);
    // PLAN_A is still 'planning': the caller's word is not the plan's status.
    expect(await planAcceptedAction(PLAN_A, 'planning', 'booked')).toEqual({ ok: true, mode: 'off', applied: [], summary: null });
    expect(snapshot()).toEqual(before);
  });

  it('ACTION-A29C7E5C3F79 a signed-out caller is sent to sign in and nothing is written', async () => {
    dial(A, POLICY_A, 'allow', 'execute');
    db.replace('concierge_plans', db.table('concierge_plans').map((p) => (p.id === PLAN_A ? { ...p, status: 'booked' } : p)));
    const before = snapshot();
    signedOut();
    await expect(planAcceptedAction(PLAN_A, 'planning', 'booked')).rejects.toThrow('NEXT_REDIRECT:/login');
    expect(snapshot()).toEqual(before);
  });
});
