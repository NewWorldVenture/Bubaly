// A concierge plan approval is `{ plan_id, kinds }`, and once approved it
// materializes the plan — a calendar event, a reminder, a prep task — on the
// APPROVER's client, with no trust gate after the vote. The one legitimate
// filer is the concierge's own gate: planAcceptedAction → evaluateTrust, as
// Bubaly, which also writes an `ai_agent` line to trust_audit_logs that no
// member can write (0260).
//
// But any member may file their own approval row (0255/0480) with a payload of
// their choosing, and create a concierge plan (0091's policy reads no role),
// and `classifyPayload`'s shape fallback routes `{ plan_id, kinds }` to the
// concierge branch. So a guest planted "Sleepover at ours, Saturday", a parent
// approved the card, and the family calendar and reminders took writes a
// guest is refused (0464), written in the parent's name. `requested_by_kind`
// is no proof either: a manager may PATCH it to 'ai' on a pending row.
//
// Now a concierge plan runs only for a row the server's ledger says Bubaly
// filed; anything else is stamped as nothing-run and answered "denied", and
// the legitimate path — accept a plan, a parent approves — still lands.
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

const { decide, editAndApprove } = await import('@/lib/services/approvals');
const { planAcceptedAction } = await import('@/app/(app)/dashboard/concierge/actions');
const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');

const FAMILY = '00000000-0000-4000-8000-00000000ad01';
const MUM = { member: '00000000-0000-4000-8000-00000000ad11', user: '00000000-0000-4000-8000-00000000ad21', role: 'parent' as const };
const DAD = { member: '00000000-0000-4000-8000-00000000ad12', user: '00000000-0000-4000-8000-00000000ad22', role: 'parent' as const };
const NAN = { member: '00000000-0000-4000-8000-00000000ad13', user: '00000000-0000-4000-8000-00000000ad23', role: 'adult' as const };
const GUEST = { member: '00000000-0000-4000-8000-00000000ad14', user: '00000000-0000-4000-8000-00000000ad24', role: 'guest' as const };
type Who = typeof MUM | typeof DAD | typeof NAN | typeof GUEST;
const PLAN = '00000000-0000-4000-8000-00000000ad31';
const PLANTED = '00000000-0000-4000-8000-00000000ad41';

const NOTHING_RUN = translate(SOURCE_MESSAGES, 'approval.memberPayloadNotRun');

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

function seedPlan(status = 'booked'): void {
  db.seed('concierge_plans', [{
    id: PLAN, family_id: FAMILY, title: 'Sleepover at ours', description: 'Pizza and a film', location: 'Our house',
    planned_for: '2026-09-19', budget_cents: null, status, created_by: GUEST.user,
  }]);
}

/** What a member can file through 0255/0480 by themselves: their own row, their own payload. */
function plantApproval(over: Record<string, unknown> = {}): void {
  db.seed('approval_requests', [{
    id: PLANTED, family_id: FAMILY, domain: 'scheduling', capability: 'automate', requested_by_kind: 'member',
    requested_by_member_id: GUEST.member, agent: null, title: 'Can we have a sleepover?', summary: 'Just saying hi',
    payload: { plan_id: PLAN, kinds: ['calendar', 'reminder', 'task'] }, payload_kind: null,
    amount_cents: null, confidence: null, policy_id: null, reasoning: null, approval_model: 'single', required_approvals: 1,
    approvals: [], status: 'pending', priority: 'normal', decided_by: null, decided_at: null, expires_at: '2099-01-01T00:00:00Z',
    executed_at: null, execution_result: null, request_id: null, run_id: null, plan_step_id: null, plan_step_ids: [],
    consequences: [], edited_payload: null, reviewed_by: null, review_note: null,
    ...over,
  }]);
}

const rows = (table: string) => db.table(table);
const approvalRow = (id: string) => rows('approval_requests').find((r) => r.id === id)!;

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
  db.seed('family_members', [MUM, DAD, NAN, GUEST].map((who) => ({
    id: who.member, family_id: FAMILY, user_id: who.user, role: who.role, is_active: true, display_name: who.role,
  })));
  db.seed('family_ai_settings', [{ family_id: FAMILY, enabled: true, behavior: 'execute' }]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('a concierge plan a member filed runs nothing, whoever approves it', () => {
  it('refuses a guest’s planted plan on a parent’s yes, and says so on the row', async () => {
    seedPlan();
    plantApproval();

    const res = await decide(scopeAs(MUM), PLANTED, 'approved');

    expect(res).toMatchObject({ ok: false, code: 'denied', error: NOTHING_RUN });
    nothingWritten();
    // The yes is on the record; what it ran is "nothing", in words.
    expect(approvalRow(PLANTED)).toMatchObject({ status: 'approved', decided_by: MUM.member });
    expect(approvalRow(PLANTED).executed_at).toBeTruthy();
    expect(String(approvalRow(PLANTED).execution_result)).toBe(`error: ${NOTHING_RUN}`);
    expect(rows('trust_audit_logs').some((r) => r.approval_id === PLANTED && r.decision === 'approved_execution'
      && String(r.reason).startsWith('Execution refused'))).toBe(true);
  });

  it('refuses one an adult filed and then relabelled as Bubaly’s — the column is not the proof', async () => {
    seedPlan();
    plantApproval({ requested_by_kind: 'ai', requested_by_member_id: null, agent: 'Concierge', title: 'Materialize: Sleepover at ours' });

    const res = await decide(scopeAs(DAD), PLANTED, 'approved');

    expect(res).toMatchObject({ ok: false, code: 'denied' });
    nothingWritten();
  });

  it('refuses it through Edit and approve too', async () => {
    seedPlan();
    plantApproval();

    const res = await editAndApprove(scopeAs(MUM), PLANTED, { calendar: true, reminder: false, task: false });

    expect(res).toMatchObject({ ok: false, code: 'denied' });
    nothingWritten();
  });
});

describe('a concierge plan Bubaly filed still lands', () => {
  /** The Autopilot dial on "ask": what the Concierge panel writes. */
  const DIAL_ON_ASK = {
    id: '00000000-0000-4000-8000-00000000ad51', family_id: FAMILY, name: 'Concierge autopilot', domain: 'scheduling', capability: 'automate',
    subject_kind: 'ai', subject_role: null, subject_member_id: null, effect: 'require_approval', conditions: {},
    approval_model: 'single', required_approvals: 1, priority: 150, enabled: true,
  };

  it('accepting a plan files the approval, and the other parent’s yes materializes it', async () => {
    seedPlan();
    db.seed('trust_policies', [DIAL_ON_ASK]);
    actAs(MUM);

    const accepted = await planAcceptedAction(PLAN, 'draft', 'booked');
    expect(accepted).toMatchObject({ ok: true, mode: 'ask' });
    const [filed] = rows('approval_requests');
    expect(filed).toMatchObject({ requested_by_kind: 'ai', payload: { plan_id: PLAN }, status: 'pending' });
    nothingWritten();

    const res = await decide(scopeAs(DAD), String(filed.id), 'approved');

    expect(res).toMatchObject({ ok: true, data: { status: 'approved', executed: true } });
    expect(rows('calendar_events')).toHaveLength(1);
    expect(rows('calendar_events')[0]).toMatchObject({ family_id: FAMILY, title: 'Sleepover at ours', all_day: true });
    expect(rows('family_reminders')).toHaveLength(2);
    expect(rows('concierge_plan_actions').map((a) => a.action_kind).sort()).toEqual(['calendar', 'reminder', 'task']);
    expect(rows('family_automation_runs')[0]).toMatchObject({ status: 'executed', state: 'completed' });
  });
});
