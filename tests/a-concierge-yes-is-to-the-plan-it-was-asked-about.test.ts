// A concierge approval is filed when a plan is accepted, and materialized
// later — a calendar event, a reminder, a prep task — on the approver's client,
// in the approver's name. It used to read the plan row as it was at THAT
// moment. Any active member may rewrite the plan meanwhile (0091's
// `concierge_plans_family` policy is FOR ALL and reads no role), so a guest
// could retitle "Soccer Saturday" after the card went out, and a parent's yes
// put "Party at ours, everyone welcome" — somewhere else, a week later — on the
// family calendar and in reminders as the parent: writes 0464 refuses the guest
// directly, and not what the card showed. The panel's never-gated approve
// (dial on "prepare") read the live plan the same way.
//
// planAcceptedAction now files the fields that become records with the ask
// (the approval payload, which 0389 freezes, and the queued run's metadata,
// which only the server and managers write). A yes materializes the plan only
// while it still says that: otherwise the row is stamped, the answer is
// "denied", and nothing is written. A row or run filed before the snapshot
// existed cannot show it and is refused the same way — the plan's own
// "Make it happen", or accepting it again, still works.
//
// Driven through the real planAcceptedAction, decide(),
// executeQueuedRunAction and the materializer on the in-memory database.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const holder = vi.hoisted(() => ({ db: null as unknown, ctx: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => holder.db, createServiceClient: () => holder.db }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => holder.ctx }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/ai/runs/continue', () => ({
  kickRun: () => {},
  continueRun: async () => ({ status: 'unavailable', completed: 0, failed: 0, pending: 0, awaitingApproval: 0, claimed: false }),
}));

const { decide } = await import('@/lib/services/approvals');
const { planAcceptedAction, executeQueuedRunAction } = await import('@/app/(app)/dashboard/concierge/actions');
const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');

const FAMILY = '00000000-0000-4000-8000-00000000b301';
const MUM = { member: '00000000-0000-4000-8000-00000000b311', user: '00000000-0000-4000-8000-00000000b321', role: 'parent' as const };
const DAD = { member: '00000000-0000-4000-8000-00000000b312', user: '00000000-0000-4000-8000-00000000b322', role: 'parent' as const };
const GUEST = { member: '00000000-0000-4000-8000-00000000b314', user: '00000000-0000-4000-8000-00000000b324', role: 'guest' as const };
type Who = typeof MUM | typeof DAD | typeof GUEST;
const PLAN = '00000000-0000-4000-8000-00000000b331';
const LEGACY = '00000000-0000-4000-8000-00000000b341';

const CHANGED = translate(SOURCE_MESSAGES, 'approval.planChangedSinceAsked');

let db: InMemorySupabase;

const scopeAs = (who: Who): ServiceScope => ({
  db: db as unknown as SupabaseClient<Database>, familyId: FAMILY, userId: who.user, memberId: who.member,
  role: who.role, actorKind: 'member', tz: 'America/New_York',
});

function actAs(who: Who): void {
  holder.ctx = {
    user: { id: who.user, email: `${who.role}@example.test` },
    active: { familyId: FAMILY, role: who.role, member: { id: who.member }, family: { id: FAMILY, timezone: 'America/New_York' } },
  };
}

function dial(effect: 'allow' | 'require_approval', behavior: 'execute' | 'prepare'): void {
  db.seed('family_ai_settings', [{ family_id: FAMILY, enabled: true, behavior }]);
  db.seed('trust_policies', [{
    id: '00000000-0000-4000-8000-00000000b351', family_id: FAMILY, name: 'Concierge autopilot', domain: 'scheduling',
    capability: 'automate', subject_kind: 'ai', subject_role: null, subject_member_id: null, effect, conditions: {},
    approval_model: 'single', required_approvals: 1, priority: 10, enabled: true, is_system: true,
  }]);
}

/** The guest's PATCH: 0091 lets any active member rewrite any field of the family's plans. */
async function guestRewritesThePlan(): Promise<void> {
  const { data, error } = await (db as unknown as SupabaseClient<Database>).from('concierge_plans')
    .update({ title: 'Party at ours, everyone welcome', location: 'Somewhere else', planned_for: '2026-09-26' })
    .eq('id', PLAN).eq('family_id', FAMILY).select('id');
  expect(error).toBeNull();
  expect(data).toHaveLength(1);
}

const rows = (table: string) => db.table(table);
const onlyRun = () => {
  const [run] = rows('family_automation_runs');
  expect(run).toBeDefined();
  return run;
};

function nothingWritten(): void {
  expect(rows('calendar_events')).toEqual([]);
  expect(rows('family_reminders')).toEqual([]);
  expect(rows('concierge_plan_actions')).toEqual([]);
}

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

/** Mum accepts the plan with the dial on "ask": Bubaly files its card and queues the panel's line. */
async function bubalyAsks(): Promise<Record<string, unknown>> {
  dial('require_approval', 'execute');
  actAs(MUM);
  expect(await planAcceptedAction(PLAN, 'planning', 'booked')).toMatchObject({ ok: true, mode: 'ask' });
  const [filed] = rows('approval_requests');
  expect(filed).toMatchObject({ requested_by_kind: 'ai', status: 'pending', payload: { plan_id: PLAN } });
  return filed;
}

describe('a plan rewritten after Bubaly asked is not materialized', () => {
  it('a parent’s yes on the card writes nothing, and the row says why', async () => {
    const filed = await bubalyAsks();
    await guestRewritesThePlan();

    const res = await decide(scopeAs(DAD), String(filed.id), 'approved');

    expect(res).toMatchObject({ ok: false, code: 'denied', error: CHANGED });
    nothingWritten();
    const row = rows('approval_requests').find((r) => r.id === filed.id)!;
    expect(row).toMatchObject({ status: 'approved', decided_by: DAD.member, execution_result: `error: ${CHANGED}` });
    expect(row.executed_at).toBeTruthy();
    expect(rows('trust_audit_logs').some((r) => r.approval_id === filed.id && r.decision === 'approved_execution'
      && String(r.reason).startsWith('Execution refused'))).toBe(true);
    // What the card was about rode with it, and 0389 freezes it there.
    expect(row).toMatchObject({
      payload: { plan: { title: 'Soccer Saturday', description: 'At the park', location: 'Riverside Park', planned_for: '2026-09-19' } },
    });
  });

  it('the panel’s approve on that card writes nothing either', async () => {
    await bubalyAsks();
    await guestRewritesThePlan();
    actAs(DAD);

    const res = await executeQueuedRunAction(String(onlyRun().id));

    expect(res).toMatchObject({ ok: false, error: CHANGED });
    nothingWritten();
  });

  it('a never-gated line on the panel ("prepare") writes nothing, and is not claimed', async () => {
    dial('allow', 'prepare');
    actAs(MUM);
    expect(await planAcceptedAction(PLAN, 'planning', 'booked')).toMatchObject({ ok: true, mode: 'ask' });
    expect(rows('approval_requests')).toEqual([]);
    await guestRewritesThePlan();
    actAs(DAD);

    const res = await executeQueuedRunAction(String(onlyRun().id));

    expect(res).toEqual({ ok: false, error: CHANGED });
    nothingWritten();
    expect(onlyRun()).toMatchObject({ status: 'pending', state: 'awaiting_approval' });
    expect(onlyRun().approved_by ?? null).toBeNull();
    // The line carried the plan as it was queued, in metadata only the server
    // and managers write (0251/0329).
    expect(onlyRun()).toMatchObject({ metadata: { plan: { title: 'Soccer Saturday', location: 'Riverside Park', planned_for: '2026-09-19' } } });
  });
});

describe('a row or line filed before Bubaly kept a copy of the plan', () => {
  it('a card with no snapshot is refused — nothing shows the plan is still what was asked', async () => {
    // A Bubaly-filed row from before this change: `{ plan_id, kinds }`, with
    // the ledger line that proves the server filed it.
    db.seed('approval_requests', [{
      id: LEGACY, family_id: FAMILY, domain: 'scheduling', capability: 'automate', requested_by_kind: 'ai',
      requested_by_member_id: MUM.member, agent: 'Concierge', title: 'Execute plan: Soccer Saturday', summary: null,
      payload: { plan_id: PLAN, kinds: ['calendar', 'reminder', 'task'] }, payload_kind: null,
      amount_cents: null, confidence: null, policy_id: null, reasoning: null, approval_model: 'single', required_approvals: 1,
      approvals: [], status: 'pending', priority: 'normal', decided_by: null, decided_at: null, expires_at: '2099-01-01T00:00:00Z',
      executed_at: null, execution_result: null, request_id: null, run_id: null, plan_step_id: null, plan_step_ids: [],
      consequences: [], edited_payload: null, reviewed_by: null, review_note: null,
    }]);
    db.seed('trust_audit_logs', [{ family_id: FAMILY, actor_kind: 'ai_agent', actor_id: 'concierge', approval_id: LEGACY, decision: 'require_approval' }]);

    const res = await decide(scopeAs(DAD), LEGACY, 'approved');

    expect(res).toMatchObject({ ok: false, code: 'denied', error: CHANGED });
    nothingWritten();
  });

  it('a never-gated line with no snapshot is refused the same way', async () => {
    db.seed('family_automation_runs', [{
      id: '00000000-0000-4000-8000-00000000b361', family_id: FAMILY, trigger_type: 'plan_accepted', status: 'pending',
      state: 'awaiting_approval', requested_by_member_id: MUM.member, summary: 'Waiting for approval: Execute plan: Soccer Saturday',
      result: {}, metadata: { plan_id: PLAN, kinds: ['calendar', 'reminder', 'task'], approval_id: null }, created_by: MUM.user,
    }]);
    actAs(DAD);

    expect(await executeQueuedRunAction('00000000-0000-4000-8000-00000000b361')).toEqual({ ok: false, error: CHANGED });
    nothingWritten();
  });
});

describe('a plan nobody changed still lands as it was asked about', () => {
  it('the other parent’s yes on the card materializes it', async () => {
    const filed = await bubalyAsks();

    const res = await decide(scopeAs(DAD), String(filed.id), 'approved');

    expect(res).toMatchObject({ ok: true, data: { status: 'approved', executed: true } });
    expect(rows('calendar_events')).toHaveLength(1);
    expect(rows('calendar_events')[0]).toMatchObject({ title: 'Soccer Saturday', location: 'Riverside Park', created_by: DAD.user });
    expect(rows('family_reminders').map((r) => r.title).sort()).toEqual(['Follow up: Soccer Saturday', 'Prep: Soccer Saturday']);
    expect(onlyRun()).toMatchObject({ status: 'executed', state: 'completed' });
  });

  it('a never-gated line is approved from the panel', async () => {
    dial('allow', 'prepare');
    actAs(MUM);
    expect(await planAcceptedAction(PLAN, 'planning', 'booked')).toMatchObject({ ok: true, mode: 'ask' });
    actAs(DAD);

    expect(await executeQueuedRunAction(String(onlyRun().id))).toMatchObject({ ok: true, mode: 'auto' });
    expect(rows('calendar_events')).toHaveLength(1);
    expect(rows('calendar_events')[0]).toMatchObject({ title: 'Soccer Saturday' });
    expect(onlyRun()).toMatchObject({ status: 'executed', state: 'completed' });
  });
});
