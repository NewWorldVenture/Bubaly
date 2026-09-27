// m7r3 — The Autopilot panel's "Do it" asks the database which approval gates a
// plan; it does not ask the run.
//
// `executeQueuedRunAction` (app/(app)/dashboard/concierge/actions.ts) routed
// through `decide()` only when the run's OWN `metadata.approval_id` was set,
// and materialised the plan directly otherwise — the direct branch being for a
// run the trust engine never gated. `family_automation_runs_update` (0251:178)
// is `can_manage_family` on USING and WITH CHECK with no column pin, and
// 0255/0329 let a manager INSERT a fresh 'queued' run whose `status` defaults
// to 'pending' with free metadata. So an adult could PATCH the key away (or
// file a row that never had it), tap "Do it", and the plan's calendar events
// and reminders were created with no vote while the two-parent approval stayed
// pending on the other parent's card, describing work already done.
//
// Now the governing approval is resolved from `approval_requests` by the plan
// it names (`payload->>'plan_id'`, which 0389 freezes), and the run's metadata
// decides nothing. Every assertion here is on what the family ends up with:
// which rows exist in calendar_events / family_reminders, what the approval
// row says, and whether the vote was recorded.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const db = vi.hoisted(() => ({ client: null as unknown }));
const ctx = vi.hoisted(() => ({ value: null as unknown }));

vi.mock('@/lib/supabase/server', () => ({
  createServer: async () => db.client,
  createServiceClient: () => db.client,
}));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => ctx.value }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/ai/runs/continue', () => ({
  kickRun: () => {},
  continueRun: async () => ({ status: 'unavailable', completed: 0, failed: 0, pending: 0, awaitingApproval: 0, claimed: false }),
}));

const { executeQueuedRunAction, dismissQueuedRunAction } = await import('@/app/(app)/dashboard/concierge/actions');

const FAMILY = '11111111-1111-4111-8111-111111111111';
const MUM = '22222222-2222-4222-8222-222222222222';
const DAD = '33333333-3333-4333-8333-333333333333';
const NAN = '44444444-4444-4444-8444-444444444444';
const PLAN = '55555555-5555-4555-8555-555555555555';
const APPROVAL = '66666666-6666-4666-8666-666666666666';
const RUN = '77777777-7777-4777-8777-777777777777';
const RUN_B = '88888888-8888-4888-8888-888888888888';

type Who = { member: string; user: string; role: 'parent' | 'adult' };
const AS_MUM: Who = { member: MUM, user: 'auth-mum', role: 'parent' };
const AS_DAD: Who = { member: DAD, user: 'auth-dad', role: 'parent' };
const AS_NAN: Who = { member: NAN, user: 'auth-nan', role: 'adult' };

let store: InMemorySupabase;

function actAs(who: Who): void {
  ctx.value = {
    user: { id: who.user },
    active: { familyId: FAMILY, role: who.role, member: { id: who.member }, family: { id: FAMILY, timezone: 'America/New_York' } },
  };
}

function seedFamilyAndPlan(): void {
  store.seed('family_members', [
    { id: MUM, family_id: FAMILY, user_id: 'auth-mum', display_name: 'Mum', role: 'parent', is_active: true },
    { id: DAD, family_id: FAMILY, user_id: 'auth-dad', display_name: 'Dad', role: 'parent', is_active: true },
    { id: NAN, family_id: FAMILY, user_id: 'auth-nan', display_name: 'Nan', role: 'adult', is_active: true },
  ]);
  store.seed('concierge_plans', [{
    id: PLAN, family_id: FAMILY, title: 'Soccer Saturday', description: 'At the park',
    location: 'Riverside Park', planned_for: '2026-09-06', budget_cents: null, status: 'booked',
  }]);
}

/** The approval planAcceptedAction files through the trust engine: payload names the plan, no payload_kind. */
function seedApproval(over: Record<string, unknown> = {}): void {
  store.seed('approval_requests', [{
    id: APPROVAL, family_id: FAMILY, domain: 'scheduling', capability: 'automate', requested_by_kind: 'ai',
    requested_by_member_id: null, agent: 'Concierge', title: 'Materialize: Soccer Saturday', summary: null,
    payload: { plan_id: PLAN, kinds: ['calendar', 'reminder', 'task'] }, payload_kind: null,
    amount_cents: null, confidence: null, policy_id: null, reasoning: 'two parents',
    approval_model: 'two_parent', required_approvals: 1, approvals: [], status: 'pending', priority: 'normal',
    decided_by: null, decided_at: null, expires_at: '2099-01-01T00:00:00Z', executed_at: null, execution_result: null,
    request_id: null, run_id: null, plan_step_id: null, plan_step_ids: [], consequences: [], edited_payload: null,
    reviewed_by: null, review_note: null, created_at: '2026-09-05T10:00:00Z',
    ...over,
  }]);
}

/** The queued run AFTER the adult's PATCH: `approval_id` is gone from its metadata. */
function seedScrubbedRun(over: Record<string, unknown> = {}): void {
  store.seed('family_automation_runs', [{
    id: RUN, family_id: FAMILY, trigger_type: 'plan_accepted', status: 'pending', state: 'awaiting_approval',
    requested_by_member_id: MUM, summary: 'Waiting for approval: Materialize: Soccer Saturday', result: {},
    metadata: { plan_id: PLAN, kinds: ['calendar', 'reminder', 'task'] },
    created_by: 'auth-mum',
    ...over,
  }]);
}

function rowsIn(table: string): Record<string, unknown>[] {
  return store.table(table) as Record<string, unknown>[];
}
function approval(): Record<string, unknown> {
  return rowsIn('approval_requests').find((r) => r.id === APPROVAL) as Record<string, unknown>;
}
function run(id = RUN): Record<string, unknown> {
  return rowsIn('family_automation_runs').find((r) => r.id === id) as Record<string, unknown>;
}

beforeEach(() => {
  store = createInMemorySupabase();
  db.client = store;
  ctx.value = null;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('"Do it" on a run whose metadata was scrubbed of its approval_id', () => {
  beforeEach(() => {
    seedFamilyAndPlan();
    seedApproval();
    seedScrubbedRun();
  });

  it('records one parent’s vote and puts NOTHING on the calendar — the two-parent rule still governs', async () => {
    actAs(AS_MUM);

    const res = await executeQueuedRunAction(RUN);

    expect(res.ok).toBe(true);
    expect(res.ok === true && res.mode).toBe('ask');
    expect(res.ok === true && res.summary).toMatch(/1 more parent needs to approve/);
    expect(rowsIn('calendar_events')).toHaveLength(0);
    expect(rowsIn('family_reminders')).toHaveLength(0);
    expect(rowsIn('concierge_plan_actions')).toHaveLength(0);
    // The vote landed on the approval the database says governs this plan.
    expect(approval().status).toBe('pending');
    expect((approval().approvals as { member_id: string }[]).map((v) => v.member_id)).toEqual([MUM]);
    expect(run().status).toBe('pending');
  });

  it('refuses an adult outright, exactly as the approval card does', async () => {
    actAs(AS_NAN);

    const res = await executeQueuedRunAction(RUN);

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/two parents/i);
    expect(rowsIn('calendar_events')).toHaveLength(0);
    expect(approval().status).toBe('pending');
    expect(run().status).toBe('pending');
  });

  it('the second parent’s tap materialises the plan AND closes this run, though decide() cannot find it by approval_id', async () => {
    actAs(AS_MUM);
    await executeQueuedRunAction(RUN);
    actAs(AS_DAD);

    const res = await executeQueuedRunAction(RUN);

    expect(res.ok).toBe(true);
    expect(res.ok === true && res.mode).toBe('auto');
    expect(rowsIn('calendar_events')).toHaveLength(1);
    expect(rowsIn('calendar_events')[0].title).toBe('Soccer Saturday');
    expect(rowsIn('family_reminders')).toHaveLength(2);
    expect(approval().status).toBe('approved');
    expect((approval().approvals as { member_id: string }[]).map((v) => v.member_id)).toEqual([MUM, DAD]);
    // The line leaves the panel: closed on all three columns.
    expect(run()).toMatchObject({ status: 'executed', state: 'completed' });
    expect(run().completed_at).toBeTruthy();
  });

  it('refuses to materialise a plan whose approval was DECLINED, even though the run still reads pending', async () => {
    store.table('approval_requests')[0].status = 'rejected';
    store.table('approval_requests')[0].decided_by = DAD;
    store.table('approval_requests')[0].approvals = [{ member_id: DAD, decision: 'rejected', note: null, at: '2026-09-05T11:00:00Z', role: 'parent' }];
    actAs(AS_MUM);

    const res = await executeQueuedRunAction(RUN);

    expect(res.ok).toBe(false);
    expect(rowsIn('calendar_events')).toHaveLength(0);
    expect(rowsIn('family_reminders')).toHaveLength(0);
    expect(approval().status).toBe('rejected');
    expect(run().status).toBe('pending');
  });
});

describe('a run a manager filed themselves, with no approval_id at all', () => {
  it('is still gated by the pending approval for its plan', async () => {
    seedFamilyAndPlan();
    seedApproval();
    // What 0255/0329 let a manager INSERT: state 'queued', status defaulted to
    // 'pending', metadata of their own writing, created_by themselves.
    store.seed('family_automation_runs', [{
      id: RUN_B, family_id: FAMILY, trigger_type: 'plan_accepted', status: 'pending', state: 'queued',
      requested_by_member_id: null, summary: 'Do it now please', result: {},
      metadata: { plan_id: PLAN, kinds: ['calendar'] }, created_by: 'auth-nan',
    }]);
    actAs(AS_MUM);

    const res = await executeQueuedRunAction(RUN_B);

    expect(res.ok).toBe(true);
    expect(res.ok === true && res.mode).toBe('ask');
    expect(rowsIn('calendar_events')).toHaveLength(0);
    expect(approval().status).toBe('pending');
    expect((approval().approvals as { member_id: string }[]).map((v) => v.member_id)).toEqual([MUM]);
  });
});

describe('what is NOT gated stays ungated', () => {
  it('a plan with no approval row at all is materialised directly — the never-gated path', async () => {
    seedFamilyAndPlan();
    seedScrubbedRun({ metadata: { plan_id: PLAN, kinds: ['calendar', 'reminder', 'task'], approval_id: null } });
    actAs(AS_NAN);

    const res = await executeQueuedRunAction(RUN);

    expect(res.ok).toBe(true);
    expect(res.ok === true && res.mode).toBe('auto');
    expect(rowsIn('calendar_events')).toHaveLength(1);
    expect(run()).toMatchObject({ status: 'executed', state: 'completed' });
  });

  it('a run that names an approval which does not govern its plan is refused, not run', async () => {
    seedFamilyAndPlan();
    // The approval exists but is for some OTHER plan.
    seedApproval({ payload: { plan_id: '99999999-9999-4999-8999-999999999999', kinds: ['calendar'] } });
    seedScrubbedRun({ metadata: { plan_id: PLAN, kinds: ['calendar'], approval_id: APPROVAL } });
    actAs(AS_MUM);

    const res = await executeQueuedRunAction(RUN);

    expect(res.ok).toBe(false);
    expect(rowsIn('calendar_events')).toHaveLength(0);
    // And the unrelated approval was not decided in Mum's name.
    expect(approval().status).toBe('pending');
    expect(approval().approvals).toEqual([]);
  });
});

describe('Dismiss on a scrubbed run', () => {
  it('is the same "no" as the approval card’s Decline, and closes the run', async () => {
    seedFamilyAndPlan();
    seedApproval();
    seedScrubbedRun();
    actAs(AS_NAN);

    const res = await dismissQueuedRunAction(RUN);

    expect(res).toEqual({ ok: true, applied: [] });
    expect(approval().status).toBe('rejected');
    expect(approval().decided_by).toBe(NAN);
    expect(rowsIn('trust_audit_logs').some((r) => r.approval_id === APPROVAL && r.decision === 'rejected')).toBe(true);
    expect(run()).toMatchObject({ status: 'dismissed', state: 'cancelled' });
    expect(rowsIn('calendar_events')).toHaveLength(0);
  });
});

// The action-level rule is the boundary here because a manager may also INSERT
// a run row without the key (see the case above), which no UPDATE pin can
// reach. 0390 is the other half: on the rows the SERVER wrote, the gate a run
// was born with cannot be scrubbed, so the panel's line and the dismiss path
// describe the vote that exists. Proven live by
// docs/audit/automation-runs-pin-what-a-member-may-queue-check.sql.
describe('the server-written cache is pinned too (0390)', () => {
  const file = (() => {
    const names = readdirSync('supabase/migrations').filter((f) => /_a_queued_run_keeps_the_gate_it_was_born_with\.sql$/.test(f));
    expect(names.length, 'the 0390 metadata-pin migration must exist').toBe(1);
    return { name: names[0], sql: readFileSync(`supabase/migrations/${names[0]}`, 'utf8') };
  })();
  const statements = file.sql.replace(/--[^\n]*/g, '');
  const PROBE = 'docs/audit/automation-runs-pin-what-a-member-may-queue-check.sql';

  it('pins approval_id and plan_id once set, for callers subject to RLS, in a BEFORE UPDATE trigger', () => {
    expect(file.name).toMatch(/^038[89]_|^0390_/);
    expect(statements).toContain('create trigger family_automation_runs_gate_is_pinned');
    expect(statements).toMatch(/before update on public\.family_automation_runs\s+for each row execute function public\.automation_run_gate_is_pinned\(\)/);
    expect(statements).toContain("(new.metadata ->> 'approval_id') is distinct from (old.metadata ->> 'approval_id')");
    expect(statements).toContain("(new.metadata ->> 'plan_id') is distinct from (old.metadata ->> 'plan_id')");
    expect(statements).toContain('select r.rolsuper or r.rolbypassrls into v_bypass');
    expect(statements).toMatch(/using errcode = '42501'/);
    expect(statements).not.toMatch(/\b(create|drop|alter)\s+policy\b/i);
    expect(statements).not.toMatch(/\bdrop\s+(table|column|function)\b/i);
    expect(statements).toContain('revoke all on function public.automation_run_gate_is_pinned() from public, anon, authenticated;');
  });

  it('is proven live, with a control that lands and a negative control that drops ONLY this trigger', () => {
    expect(existsSync(PROBE)).toBe(true);
    const probe = readFileSync(PROBE, 'utf8');
    expect(probe).toContain('dropped approval_id from a queued run');
    expect(probe).toContain('pointed a queued run at a different approval');
    expect(probe).toContain('could not add an unrelated key to a queued run');
    expect(probe).toContain('drop trigger if exists family_automation_runs_gate_is_pinned on public.family_automation_runs;');
    expect(probe).toContain("with 0390''s trigger removed the manager''s scrub of approval_id touched");
  });
});
