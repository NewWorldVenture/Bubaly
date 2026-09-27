// Two findings about the same screen, and the same column.
//
// m7 — A family that picks "Two parents" in Trust & Permissions gets that rule
// from `decide()` and from nowhere else. The Autopilot panel on the Concierge
// page had its OWN approve button (`executeQueuedRunAction`), which checked
// `isManager` and then stamped the approval `status = 'approved'` itself without
// reading `approval_model`, `required_approvals` or `approvals` — so one adult's
// tap materialised the plan (real calendar events and reminders) while the
// identical row on the approval card would have said "This one needs two
// parents to agree."
//
// m8 — On a row that DOES need two yeses, the first approver's edit was
// invisible to the second (`toApprovalCardData` read `payload` and never
// `edited_payload`) and was destroyed if they used Edit at all
// (`editAndApprove` re-based its merge on the ORIGINAL payload), even though
// plain Approve executes it. Mum's "bring boots and shin pads" vanished from
// the calendar while both parents were told their change went through.
//
// Every assertion below is on what the family ends up with: which rows exist in
// calendar_events / family_reminders, which tool arguments actually ran, and
// what the second approver's card says.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { withLocale } from './helpers/render-translated';
import { toApprovalCardData, type TrustApproval } from '@/lib/approvals/card-data';

const executed = vi.hoisted(() => ({ calls: [] as { name: string; args: unknown }[] }));
const db = vi.hoisted(() => ({ client: null as unknown }));
const ctx = vi.hoisted(() => ({ value: null as unknown }));

vi.mock('@/lib/supabase/server', () => ({
  createServer: async () => db.client,
  // The run ledger and the trust audit reach for the service role; in this
  // harness it is the same in-memory store, so those rows are assertable too.
  createServiceClient: () => db.client,
}));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => ctx.value }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/ai/runs/continue', () => ({
  kickRun: () => {},
  continueRun: async () => ({ status: 'unavailable', completed: 0, failed: 0, pending: 0, awaitingApproval: 0, claimed: false }),
}));
vi.mock('@/lib/ai/tools/execute', () => ({
  executeTool: async (_scope: unknown, name: string, args: unknown) => {
    executed.calls.push({ name, args });
    return { status: 'ok', data: { id: 'ev-1' }, summary: `Did ${name}`, toolCallId: 'call-1', verified: true };
  },
}));

// The approval card is rendered below, the way tests/approval-card.test.ts
// renders it; its buttons' server actions are not what is on trial there.
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));
vi.mock('@/app/(app)/dashboard/approvals-actions', () => ({
  decideApproval: async () => ({ ok: true, data: { status: 'approved', executed: true, resumedRunId: null, summary: 'done' } }),
  editAndApproveApproval: async () => ({ ok: true, data: { status: 'modified', resumedRunId: null } }),
}));

const { decide, editAndApprove } = await import('@/lib/services/approvals');
const { executeQueuedRunAction, dismissQueuedRunAction } = await import('@/app/(app)/dashboard/concierge/actions');
const { ApprovalCard } = await import('@/components/approvals/approval-card');
const { ToastProvider } = await import('@/components/ui/toast');

const FAMILY = '11111111-1111-4111-8111-111111111111';
const MUM = '22222222-2222-4222-8222-222222222222';
const DAD = '33333333-3333-4333-8333-333333333333';
const NAN = '44444444-4444-4444-8444-444444444444';
const PLAN = '55555555-5555-4555-8555-555555555555';
const APPROVAL = '66666666-6666-4666-8666-666666666666';
const RUN = '77777777-7777-4777-8777-777777777777';

const MEMBERS = [
  { id: MUM, family_id: FAMILY, user_id: 'auth-mum', display_name: 'Mum', role: 'parent', is_active: true },
  { id: DAD, family_id: FAMILY, user_id: 'auth-dad', display_name: 'Dad', role: 'parent', is_active: true },
  { id: NAN, family_id: FAMILY, user_id: 'auth-nan', display_name: 'Nan', role: 'adult', is_active: true },
];

type Who = { member: string; user: string; role: 'parent' | 'adult' };
const AS_MUM: Who = { member: MUM, user: 'auth-mum', role: 'parent' };
const AS_DAD: Who = { member: DAD, user: 'auth-dad', role: 'parent' };
const AS_NAN: Who = { member: NAN, user: 'auth-nan', role: 'adult' };

let store: InMemorySupabase;

/** The user context the Concierge server action reads. */
function actAs(who: Who): void {
  ctx.value = {
    user: { id: who.user },
    active: {
      familyId: FAMILY,
      role: who.role,
      member: { id: who.member },
      family: { id: FAMILY, timezone: 'America/New_York' },
    },
  };
}

/** The service scope the approvals service reads. */
function scopeAs(who: Who): ServiceScope {
  return {
    db: store as unknown as SupabaseClient<Database>,
    familyId: FAMILY,
    userId: who.user,
    memberId: who.member,
    role: who.role,
    actorKind: 'member',
    tz: 'America/New_York',
  };
}

function approvalRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: APPROVAL,
    family_id: FAMILY,
    domain: 'calendar',
    capability: 'automate',
    requested_by_kind: 'ai',
    requested_by_member_id: null,
    agent: 'Concierge',
    title: 'Add soccer Saturday',
    summary: null,
    payload: { name: 'calendar.createEvent', args: { title: 'Soccer', starts_at: '2026-09-06T13:00:00Z' } },
    payload_kind: 'tool',
    amount_cents: null,
    confidence: 0.9,
    policy_id: null,
    reasoning: 'risk tier',
    approval_model: 'two_parent',
    required_approvals: 1,
    approvals: [],
    status: 'pending',
    priority: 'normal',
    decided_by: null,
    decided_at: null,
    expires_at: '2099-01-01T00:00:00Z',
    executed_at: null,
    execution_result: null,
    request_id: null,
    run_id: null,
    plan_step_id: null,
    plan_step_ids: [],
    consequences: [],
    evidence: null,
    edited_payload: null,
    reviewed_by: null,
    review_note: null,
    ...over,
  };
}

/** The Concierge shape: an accepted plan, an approval for it, a queued run. */
function seedQueuedConciergePlan(over: Record<string, unknown> = {}): void {
  store.seed('family_members', MEMBERS);
  store.seed('concierge_plans', [{
    id: PLAN, family_id: FAMILY, title: 'Soccer Saturday', description: 'At the park',
    location: 'Riverside Park', planned_for: '2026-09-06', budget_cents: null, status: 'booked',
  }]);
  store.seed('approval_requests', [approvalRow({
    domain: 'scheduling',
    payload: { plan_id: PLAN, kinds: ['calendar', 'reminder', 'task'] },
    payload_kind: 'concierge_plan',
    title: 'Materialize: Soccer Saturday',
    ...over,
  })]);
  store.seed('family_automation_runs', [{
    id: RUN, family_id: FAMILY, trigger_type: 'plan_accepted', status: 'pending',
    state: 'awaiting_approval', requested_by_member_id: MUM,
    summary: 'Waiting for approval: Materialize: Soccer Saturday', result: {},
    metadata: { plan_id: PLAN, kinds: ['calendar', 'reminder', 'task'], approval_id: APPROVAL },
    created_by: 'auth-mum',
  }]);
}

function rowsIn(table: string): Record<string, unknown>[] {
  return store.table(table) as Record<string, unknown>[];
}

function approval(): Record<string, unknown> {
  return rowsIn('approval_requests')[0];
}

beforeEach(() => {
  executed.calls = [];
  store = createInMemorySupabase();
  db.client = store;
  ctx.value = null;
});

describe('the Autopilot panel obeys the family’s approval model', () => {
  it('one parent’s tap records a vote and puts NOTHING on the calendar', async () => {
    seedQueuedConciergePlan();
    actAs(AS_MUM);

    const res = await executeQueuedRunAction(RUN);

    expect(res.ok).toBe(true);
    expect(res.ok === true && res.summary).toMatch(/1 more parent needs to approve/);
    // The family's calendar is untouched: this is the outcome the "Two parents"
    // label promises and the one the old code broke.
    expect(rowsIn('calendar_events')).toHaveLength(0);
    expect(rowsIn('family_reminders')).toHaveLength(0);
    expect(rowsIn('concierge_plan_actions')).toHaveLength(0);
    // And the request is still open, so Dad can still vote.
    expect(approval().status).toBe('pending');
    expect(approval().decided_by ?? null).toBeNull();
    expect(rowsIn('family_automation_runs')[0].status).toBe('pending');
  });

  it('the second parent’s tap is what materialises the plan', async () => {
    seedQueuedConciergePlan();
    actAs(AS_MUM);
    await executeQueuedRunAction(RUN);

    actAs(AS_DAD);
    const res = await executeQueuedRunAction(RUN);

    expect(res.ok).toBe(true);
    expect(rowsIn('calendar_events')).toHaveLength(1);
    expect(rowsIn('calendar_events')[0].title).toBe('Soccer Saturday');
    // reminder + prep task
    expect(rowsIn('family_reminders')).toHaveLength(2);
    expect(approval().status).toBe('approved');
    // Both parents' yeses are on the row, each in its own name — the shape
    // 0381's trigger requires of a decision.
    expect((approval().approvals as { member_id: string }[]).map((v) => v.member_id)).toEqual([MUM, DAD]);
    expect(rowsIn('family_automation_runs')[0]).toMatchObject({ status: 'executed', state: 'completed' });
    // What the panel is told was applied is what THIS decision applied.
    expect(res.ok === true && [...res.applied].sort()).toEqual(['calendar', 'reminder', 'task']);
  });

  it('refuses an adult outright on a two-parent row, exactly as the approval card does', async () => {
    seedQueuedConciergePlan();
    actAs(AS_NAN);

    const res = await executeQueuedRunAction(RUN);

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/two parents/i);
    expect(rowsIn('calendar_events')).toHaveLength(0);
    expect(rowsIn('family_reminders')).toHaveLength(0);
    expect(approval().status).toBe('pending');
  });

  it('a single-approver row still goes through on one tap — and now leaves the decision on the record', async () => {
    seedQueuedConciergePlan({ approval_model: 'single', required_approvals: 1 });
    actAs(AS_NAN);

    const res = await executeQueuedRunAction(RUN);

    expect(res.ok).toBe(true);
    expect(rowsIn('calendar_events')).toHaveLength(1);
    expect(approval().status).toBe('approved');
    expect(rowsIn('family_automation_runs')[0].status).toBe('executed');
    // The old button stamped the row itself and wrote no decision to the trust
    // audit; only `decide()` does. This is what makes the single-approver case
    // a test of the routing and not only of the outcome.
    expect(rowsIn('trust_audit_logs').some((r) => r.approval_id === APPROVAL && r.decision === 'approved')).toBe(true);
  });
});

describe('the Autopilot panel’s Dismiss is the same "no" as the approval card’s Decline', () => {
  it('declines the approval through decide(): the "no" is recorded, audited, and closes the run', async () => {
    seedQueuedConciergePlan();
    // An adult may not approve a two-parent row, but one "no" from anyone
    // still stops the AI.
    actAs(AS_NAN);

    const res = await dismissQueuedRunAction(RUN);

    expect(res).toEqual({ ok: true, applied: [] });
    expect(approval().status).toBe('rejected');
    expect(approval().decided_by).toBe(NAN);
    expect((approval().approvals as { member_id: string; decision: string }[]))
      .toEqual([expect.objectContaining({ member_id: NAN, decision: 'rejected' })]);
    expect(rowsIn('trust_audit_logs').some((r) => r.approval_id === APPROVAL && r.decision === 'rejected')).toBe(true);
    // Closed on BOTH columns: "Needs you" reads `state`.
    expect(rowsIn('family_automation_runs')[0]).toMatchObject({ status: 'dismissed', state: 'cancelled' });
    expect(rowsIn('calendar_events')).toHaveLength(0);
  });

  it('still clears a stale line whose approval was already decided elsewhere, without re-deciding it', async () => {
    seedQueuedConciergePlan({ status: 'approved', decided_by: MUM, decided_at: '2026-09-05T11:00:00Z' });
    actAs(AS_DAD);

    const res = await dismissQueuedRunAction(RUN);

    expect(res).toEqual({ ok: true, applied: [] });
    expect(approval().status).toBe('approved');
    expect(approval().decided_by).toBe(MUM);
    expect(rowsIn('family_automation_runs')[0]).toMatchObject({ status: 'dismissed', state: 'cancelled' });
  });
});

describe('a second approver decides on what will actually run', () => {
  beforeEach(() => {
    store.seed('family_members', MEMBERS);
    store.seed('approval_requests', [approvalRow()]);
  });

  it('keeps the first approver’s wording when the second edits a different field', async () => {
    const first = await editAndApprove(scopeAs(AS_MUM), APPROVAL, { title: 'Soccer — bring boots and shin pads' });
    expect(first).toMatchObject({ ok: true, data: { status: 'pending' } });
    expect(executed.calls).toEqual([]);

    const second = await editAndApprove(scopeAs(AS_DAD), APPROVAL, { starts_at: '2026-09-06T14:00:00Z' });
    expect(second).toMatchObject({ ok: true, data: { status: 'modified' } });

    // Both parents' corrections are in the event that gets created.
    expect(executed.calls).toHaveLength(1);
    expect(executed.calls[0].args).toEqual({
      title: 'Soccer — bring boots and shin pads',
      starts_at: '2026-09-06T14:00:00Z',
    });
  });

  it('does not revert the first approver when the second opens Edit and changes nothing', async () => {
    await editAndApprove(scopeAs(AS_MUM), APPROVAL, { title: 'Soccer — bring boots and shin pads' });
    await editAndApprove(scopeAs(AS_DAD), APPROVAL, {});

    expect(executed.calls).toHaveLength(1);
    expect(executed.calls[0].args).toMatchObject({ title: 'Soccer — bring boots and shin pads' });
  });

  it('lets the second approver overrule one field on purpose — and only that field', async () => {
    // Mum changes two things; Dad deliberately rewrites one of them. Last
    // writer wins on the field Dad touched, and Mum's OTHER change survives —
    // which is the half re-basing on Bubaly's original used to throw away.
    await editAndApprove(scopeAs(AS_MUM), APPROVAL, { title: 'Soccer — bring boots', starts_at: '2026-09-06T14:00:00Z' });
    await editAndApprove(scopeAs(AS_DAD), APPROVAL, { title: 'Soccer — Dad is driving' });

    expect(executed.calls).toHaveLength(1);
    expect(executed.calls[0].args).toEqual({ title: 'Soccer — Dad is driving', starts_at: '2026-09-06T14:00:00Z' });
  });

  it('shows the first approver’s edit on the second approver’s card, and says it was edited', async () => {
    await editAndApprove(scopeAs(AS_MUM), APPROVAL, { title: 'Soccer — bring boots and shin pads' });

    const card = toApprovalCardData(approval() as unknown as TrustApproval, {
      requestedBy: 'Bubaly', canEdit: true, managerCount: 3,
    });

    expect(card.editableFields?.find((f) => f.key === 'title')?.value)
      .toBe('Soccer — bring boots and shin pads');
    expect(card.editedFields).toEqual(['Title']);
  });

  it('and the card SAYS so, in words, above the buttons', async () => {
    await editAndApprove(scopeAs(AS_MUM), APPROVAL, { title: 'Soccer — bring boots and shin pads' });
    const card = toApprovalCardData(approval() as unknown as TrustApproval, {
      requestedBy: 'Bubaly', canEdit: true, managerCount: 3,
    });

    const html = renderToStaticMarkup(withLocale(
      React.createElement(ToastProvider, null, React.createElement(ApprovalCard, { approval: card, canDecide: true })),
    ));

    // Rendered with the real en-US catalogue. `approval.alreadyChangedByAnApprover`
    // is queued for the catalogues in scratchpad/i18n-asks/m7+m8.json, so this is
    // RED until that merge lands — which is the point: without the copy the card
    // prints the raw key, and a test that resolved the key to itself would pass.
    expect(html).toContain('Already changed by an approver: Title');
    expect(html).not.toContain('approval.alreadyChangedByAnApprover');
  });

  it('leaves an un-edited card exactly as it was', () => {
    const card = toApprovalCardData(approval() as unknown as TrustApproval, {
      requestedBy: 'Bubaly', canEdit: true, managerCount: 3,
    });
    expect(card.editableFields?.find((f) => f.key === 'title')?.value).toBe('Soccer');
    expect(card.editedFields).toBeUndefined();
  });

  it('still ignores a stored payload that reaches past the fields the card offered', async () => {
    store.table('approval_requests')[0].approvals = [
      { member_id: MUM, decision: 'approved', note: null, at: '2026-09-05T11:00:00Z', role: 'parent' },
    ];
    store.table('approval_requests')[0].edited_payload = {
      title: 'Soccer', starts_at: '2026-09-06T13:00:00Z', family_id: 'someone-elses',
    };

    await decide(scopeAs(AS_DAD), APPROVAL, 'approved');

    expect(executed.calls).toHaveLength(1);
    expect(executed.calls[0].args).not.toHaveProperty('family_id');
  });
});

// The action-level rule above is not a boundary on its own: `approval_requests`
// is reachable with the signed-in browser session, and `approval_requests_decide`
// (0251:135-137) gated on `can_manage_family` and named no column, so one PATCH
// set `status = 'approved'` — and a second way round was to write two parents'
// votes into `approvals` first. 0381 moves the rule into the database.
//
// What PROVES it is docs/audit/two-parents-means-two-parents-check.sql: a live
// probe run against a replayed Postgres (CI's "Boundary probes" step globs
// docs/audit/*-check.sql), with a negative control that drops the trigger and
// requires both flips to land again. The cases here are the source half — they
// pin the design choices that probe cannot see from outside, and they keep the
// probe from being deleted without a red test.
describe('the threshold is kept by the database, not only by the action', () => {
  const file = (() => {
    const names = readdirSync('supabase/migrations')
      .filter((f) => /_two_parents_means_two_parents_in_the_database_too\.sql$/.test(f));
    expect(names.length, 'the 0381 approval-threshold migration must exist').toBe(1);
    return { name: names[0], sql: readFileSync(`supabase/migrations/${names[0]}`, 'utf8') };
  })();
  // Comments stripped: the header discusses DEFINER, GRANTs and policies in prose.
  const statements = file.sql.replace(/--[^\n]*/g, '');
  const PROBE = 'docs/audit/two-parents-means-two-parents-check.sql';

  it('is proven live by a boundary probe that has been shown to fail', () => {
    expect(existsSync(PROBE), `${PROBE} is the live proof of 0381`).toBe(true);
    const probe = readFileSync(PROBE, 'utf8');
    // The negative control: without the trigger the defect must reproduce.
    expect(probe).toContain('drop trigger if exists approval_requests_decision_is_earned on public.approval_requests;');
    // Forged votes are the case a WITH CHECK on the threshold alone let through.
    expect(probe).toContain('wrote both parents');
    // And a stamp on a row decided before 0381 must still land.
    expect(probe).toContain('Approved before 0381');
  });

  it('decides on the TRANSITION, in a trigger that can see OLD — not in a policy that re-checks every later write', () => {
    expect(statements).toContain('create trigger approval_requests_decision_is_earned');
    expect(statements).toContain("if new.status in ('approved', 'modified') and new.status is distinct from old.status then");
    expect(statements).toContain('public.approval_votes_satisfy(old.family_id, old.approval_model, old.required_approvals, v_new)');
    // approval_requests_decide is left as 0251 wrote it.
    expect(statements).not.toMatch(/\b(create|drop)\s+policy\b/i);
  });

  it('counts only votes their voters cast: one added vote per write, in the caller’s own name', () => {
    expect(statements).toContain('fm.user_id = auth.uid()');
    expect(statements).toContain('if v_added > 1 or v_foreign > 0 then');
  });

  it('mirrors thresholdFor: two_parent is two AND parents, consensus counts the household', () => {
    const fn = statements.slice(statements.indexOf('function public.approval_votes_satisfy'));
    expect(fn).toContain("if p_model = 'two_parent' then");
    expect(fn).toContain('v_required := greatest(2, v_floor);');
    expect(fn).toContain('v_parents_only := true;');
    expect(fn).toContain("elsif p_model = 'consensus' then");
    expect(fn).toContain("and fm.role in ('parent', 'adult')");
    // A bare {"status":"approved"} PATCH leaves `approvals` at its '[]' default
    // (0093:106 is NOT NULL), so what refuses it is the count, not a null guard.
    expect(fn).toContain('return v_counted >= v_required;');
  });

  it('is not a membership oracle: no SECURITY DEFINER, and no EXECUTE for PUBLIC or anon', () => {
    expect(statements).not.toMatch(/security\s+definer/i);
    expect(statements).toContain('revoke all on function public.approval_votes_satisfy(uuid, text, integer, jsonb) from public, anon;');
    expect(statements).toContain('grant execute on function public.approval_votes_satisfy(uuid, text, integer, jsonb) to authenticated, service_role;');
  });

  it('closes the one-extra-PATCH route by pinning the rule columns', () => {
    expect(statements).toContain('create trigger approval_requests_rule_is_immutable');
    const guard = statements.slice(statements.indexOf('function public.approval_rule_is_immutable'));
    expect(guard).toContain('new.approval_model is distinct from old.approval_model');
    expect(guard).toContain('new.required_approvals is distinct from old.required_approvals');
    expect(guard).toMatch(/raise exception/);
  });

  it('is safe to replay and removes nothing', () => {
    expect(statements).toContain('drop trigger if exists approval_requests_decision_is_earned on public.approval_requests;');
    expect(statements).toContain('drop trigger if exists approval_requests_rule_is_immutable on public.approval_requests;');
    expect(statements).toMatch(/create or replace function public\.approval_votes_satisfy/);
    expect(statements).toMatch(/create or replace function public\.approval_decision_is_earned/);
    expect(statements).not.toMatch(/\bdrop\s+(table|column|function)\b/i);
  });
});
