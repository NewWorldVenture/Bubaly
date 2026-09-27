// m7r4 — "Approve" and "Skip" on the automation pages are the family's vote,
// not a status flip.
//
// /dashboard/family-automation and /dashboard/autonomous-family-management draw
// Approve / Skip (components/family/record-actions.tsx AutomationApproval) for
// every `family_automation_runs` row whose legacy `status` is 'pending'. Two
// kinds of row sit there with a vote standing between them and the family: a
// concierge plan the "ask first" dial queued beside an `approval_requests` row
// that may say "Two parents", and a §10 run the executor parked on a step's
// approval.
//
// `resolveAutomationRun` (lib/family/actions.ts) used to stamp
// `status = 'approved' | 'skipped'` + approved_by/approved_at on the row by id
// and read nothing else. So one parent's tap took a two-parent line out of the
// queue as "approved" with nobody having voted, the other parent's approval
// card stayed open, a "Skip" was no "no" (the card could still approve the plan
// in), and once the card DID approve it `decide()` could not close the run —
// it closes only rows still at 'pending' — so the run sat on "Needs you" for
// good. Now the row's own gate decides what the tap means.
//
// Every assertion is on what the family ends up with: the run row, the
// approval row and its votes, what landed on the calendar, and the household
// trail row (`audit_logs`), which says 'vote' for a yes that did not close the
// approval and 'approve' only when it did.
//
// TWO BEHAVIOUR CHANGES BEYOND THE BUG, both deliberate:
//   1. Approve on a concierge line nothing gates now CARRIES OUT the plan,
//      through executeQueuedRunAction's never-gated path — before, it stamped
//      'approved' and nothing was done.
//   2. Skip on a concierge line now leaves it 'dismissed' / state 'cancelled'
//      (the Autopilot panel's terminal state), not 'skipped'. So it no longer
//      shows in family-automation's "Recent" list, which reads
//      approved/executed/skipped, nor in autonomous-family-management's done
//      list, which reads approved/executed.
//
// The refusal sentences are asserted against the REAL en-US catalogue.
// `actions.runWaitsOnItsApproval` and `actions.runApprovalAlreadyDecidedSkip`
// are new with this fix and reach lib/i18n/messages/*.json in the catalogue
// merge (scratchpad i18n-asks/m7r4.json); until that merge lands, the cases
// that assert them are RED — `t()` returns the raw key for a missing entry, and
// a parent would see that key, which is exactly what they must catch.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const EN_US = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;
/** The English sentence for `key`, failing loudly when the catalogue has none. */
function english(key: string): string {
  expect(EN_US[key], `${key} is missing from en-US.json`).toEqual(expect.any(String));
  return EN_US[key];
}

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

const { resolveAutomationRun } = await import('@/lib/family/actions');

const FAMILY = '11111111-1111-4111-8111-111111111111';
const MUM = '22222222-2222-4222-8222-222222222222';
const DAD = '33333333-3333-4333-8333-333333333333';
const NAN = '44444444-4444-4444-8444-444444444444';
const PLAN = '55555555-5555-4555-8555-555555555555';
const APPROVAL = '66666666-6666-4666-8666-666666666666';
const RUN = '77777777-7777-4777-8777-777777777777';

type Who = { member: string; user: string; role: 'parent' | 'adult' };
const AS_MUM: Who = { member: MUM, user: 'auth-mum', role: 'parent' };
const AS_DAD: Who = { member: DAD, user: 'auth-dad', role: 'parent' };
const AS_NAN: Who = { member: NAN, user: 'auth-nan', role: 'adult' };

let store: InMemorySupabase;

function actAs(who: Who): void {
  ctx.value = {
    user: { id: who.user, email: `${who.user}@example.test` },
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

/** The approval planAcceptedAction files when the family chose "Two parents". */
function seedTwoParentApproval(over: Record<string, unknown> = {}): void {
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

/** The Autopilot line planAcceptedAction writes beside it, exactly as the server writes it. */
function seedQueuedPlanRun(over: Record<string, unknown> = {}): void {
  store.seed('family_automation_runs', [{
    id: RUN, family_id: FAMILY, trigger_type: 'plan_accepted', status: 'pending', state: 'awaiting_approval',
    requested_by_member_id: MUM, summary: 'Waiting for approval: Materialize: Soccer Saturday', result: {},
    metadata: { plan_id: PLAN, kinds: ['calendar', 'reminder', 'task'], approval_id: APPROVAL, basis: 'policy', reason: 'two parents' },
    approved_by: null, approved_at: null, completed_at: null,
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
function run(): Record<string, unknown> {
  return rowsIn('family_automation_runs').find((r) => r.id === RUN) as Record<string, unknown>;
}
function voters(): string[] {
  return (approval().approvals as { member_id: string }[]).map((v) => v.member_id);
}
/** What the household trail recorded against this run, in order. */
function trail(): string[] {
  return rowsIn('audit_logs').filter((r) => r.resource_id === RUN).map((r) => r.action as string);
}

/**
 * The store, with another writer's change to one row landing between this
 * action's read and its write — the approval card's `decide()` closing the run,
 * say. Fires once, on the first UPDATE of `table`, just before it executes.
 */
function aConcurrentWriteLandsFirst(table: string, id: string, patch: Record<string, unknown>): unknown {
  let landed = false;
  return new Proxy(store as object, {
    get(target, prop, receiver) {
      if (prop !== 'from') return Reflect.get(target, prop, receiver);
      return (name: string) => {
        const builder = store.from(name);
        if (name !== table) return builder;
        const update = builder.update.bind(builder);
        builder.update = (values, opts) => {
          if (!landed) {
            landed = true;
            Object.assign(store.table(table).find((r) => r.id === id) ?? {}, patch);
          }
          return update(values, opts);
        };
        return builder;
      };
    },
  });
}

/** The store, with every read of one table answering a database error. */
function failingReadsOf(table: string): unknown {
  const failing = () => {
    const chain: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'in', 'is', 'not', 'filter', 'gte', 'lte', 'order', 'limit', 'maybeSingle', 'single']) chain[m] = () => chain;
    chain.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: null, error: { message: 'connection reset', code: '08006', details: '', hint: '' } }).then(resolve);
    return chain;
  };
  return new Proxy(store as object, {
    get(target, prop, receiver) {
      if (prop === 'from') return (name: string) => (name === table ? failing() : (store as unknown as { from: (n: string) => unknown }).from(name));
      return Reflect.get(target, prop, receiver);
    },
  });
}

beforeEach(() => {
  store = createInMemorySupabase();
  db.client = store;
  ctx.value = null;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('a two-parent Autopilot line, approved from the automation page', () => {
  beforeEach(() => {
    seedFamilyAndPlan();
    seedTwoParentApproval();
    seedQueuedPlanRun();
  });

  it('one parent’s tap is one vote: the line stays waiting, nothing is stamped approved, nothing lands', async () => {
    actAs(AS_MUM);

    const res = await resolveAutomationRun(RUN, 'approved');

    expect(res.ok).toBe(true);
    // The parent is told why the line did not move.
    expect(res.ok === true && res.note).toMatch(/1 more parent needs to approve/);
    expect(run()).toMatchObject({ status: 'pending', state: 'awaiting_approval', approved_by: null, approved_at: null });
    expect(approval().status).toBe('pending');
    expect(voters()).toEqual([MUM]);
    expect(rowsIn('calendar_events')).toHaveLength(0);
    expect(rowsIn('family_reminders')).toHaveLength(0);
    // A recorded vote, not an approval: nothing was approved yet.
    expect(trail()).toEqual(['vote']);
  });

  it('the second parent’s tap lands the plan and closes the line as done — it does not sit on "Needs you"', async () => {
    actAs(AS_MUM);
    await resolveAutomationRun(RUN, 'approved');
    actAs(AS_DAD);

    const res = await resolveAutomationRun(RUN, 'approved');

    // Done, so no "N more needed" note: the line leaves the list on refresh.
    expect(res).toEqual({ ok: true, id: RUN });
    expect(approval().status).toBe('approved');
    expect(voters()).toEqual([MUM, DAD]);
    expect(rowsIn('calendar_events')).toHaveLength(1);
    expect(rowsIn('calendar_events')[0].title).toBe('Soccer Saturday');
    expect(run()).toMatchObject({ status: 'executed', state: 'completed' });
    expect(run().completed_at).toBeTruthy();
    expect(trail()).toEqual(['vote', 'approve']);
  });

  it('an adult who is not a parent cannot approve it here any more than on the approval card', async () => {
    actAs(AS_NAN);

    const res = await resolveAutomationRun(RUN, 'approved');

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/two parents/i);
    expect(run()).toMatchObject({ status: 'pending', approved_by: null });
    expect(approval().status).toBe('pending');
    expect(approval().approvals).toEqual([]);
    expect(trail()).toEqual([]);
  });

  it('"Skip" is the family’s "no": the approval is declined, so the other parent cannot approve the plan in afterwards', async () => {
    actAs(AS_MUM);

    const res = await resolveAutomationRun(RUN, 'skipped');

    expect(res.ok).toBe(true);
    expect(approval().status).toBe('rejected');
    expect(approval().decided_by).toBe(MUM);
    expect(run()).toMatchObject({ status: 'dismissed', state: 'cancelled' });
    expect(rowsIn('calendar_events')).toHaveLength(0);
    expect(trail()).toEqual(['skip']);
  });

  it('an approval already decided elsewhere is not overridden by the line', async () => {
    const row = store.table('approval_requests')[0] as Record<string, unknown>;
    row.status = 'rejected';
    row.decided_by = DAD;
    row.approvals = [{ member_id: DAD, decision: 'rejected', note: null, at: '2026-09-05T11:00:00Z', role: 'parent' }];
    actAs(AS_MUM);

    const res = await resolveAutomationRun(RUN, 'approved');

    expect(res.ok).toBe(false);
    // Worded for THIS page, whose button is "Skip" — not the Autopilot
    // panel's "Dismiss the line".
    expect(res.ok === false && res.error).toBe(english('actions.runApprovalAlreadyDecidedSkip'));
    expect(english('actions.runApprovalAlreadyDecidedSkip')).toContain(english('recordActions.skip'));
    expect(run()).toMatchObject({ status: 'pending', approved_by: null });
    expect(approval().status).toBe('rejected');
    expect(rowsIn('calendar_events')).toHaveLength(0);
  });

  it('a failed read of the approval does nothing and says so — it is not "no approval"', async () => {
    db.client = failingReadsOf('approval_requests');
    actAs(AS_MUM);

    const res = await resolveAutomationRun(RUN, 'approved');

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toBeTruthy();
    expect(run()).toMatchObject({ status: 'pending', state: 'awaiting_approval', approved_by: null });
    expect(approval().status).toBe('pending');
    expect(rowsIn('calendar_events')).toHaveLength(0);
  });

  it('a failed read of the run itself does nothing and says it could not check', async () => {
    db.client = failingReadsOf('family_automation_runs');
    actAs(AS_MUM);

    const res = await resolveAutomationRun(RUN, 'approved');

    // Not "not found or already handled": the read failed, it did not come back empty.
    expect(res).toEqual({ ok: false, error: english('actions.couldNotCheckRunApproval') });
    expect(run()).toMatchObject({ status: 'pending', state: 'awaiting_approval', approved_by: null });
    expect(approval().status).toBe('pending');
    expect(approval().approvals).toEqual([]);
    expect(trail()).toEqual([]);
  });

  it('a Skip that loses the race to the approval card does not relabel a plan that landed as dismissed', async () => {
    // Dad approved on the card; the line is still pending here when Mum taps
    // Skip, and decide() closes the run as executed before her write lands.
    const row = store.table('approval_requests')[0] as Record<string, unknown>;
    row.status = 'approved';
    row.decided_by = DAD;
    db.client = aConcurrentWriteLandsFirst('family_automation_runs', RUN, {
      status: 'executed', state: 'completed', completed_at: '2026-09-05T11:00:00Z', approved_by: 'auth-dad',
    });
    actAs(AS_MUM);

    const res = await resolveAutomationRun(RUN, 'skipped');

    expect(res).toEqual({ ok: false, error: english('actions.runNotFoundOrAlready') });
    expect(run()).toMatchObject({ status: 'executed', state: 'completed', approved_by: 'auth-dad' });
    expect(trail()).toEqual([]);
  });
});

describe('a run the executor parked on a step’s approval', () => {
  function seedParkedRun(state: string): void {
    seedFamilyAndPlan();
    store.seed('family_automation_runs', [{
      id: RUN, family_id: FAMILY, trigger_type: 'concierge', run_type: 'concierge', status: 'pending', state,
      plan_id: '99999999-9999-4999-8999-999999999999', requested_by_member_id: MUM, summary: 'Book the plumber',
      result: {}, metadata: {}, approved_by: null, approved_at: null, created_by: 'auth-mum',
    }]);
    seedTwoParentApproval({
      title: 'Book the plumber', payload: { kind: 'plan_steps', run_id: RUN, step_ids: ['step-1'], input: {} },
      payload_kind: 'plan_steps', run_id: RUN, plan_step_id: 'step-1', plan_step_ids: ['step-1'], approval_model: 'single',
    });
  }

  it('is not approved by flipping its status: the step’s approval card is the decision', async () => {
    seedParkedRun('awaiting_approval');
    actAs(AS_MUM);

    const res = await resolveAutomationRun(RUN, 'approved');

    expect(res).toEqual({ ok: false, error: english('actions.runWaitsOnItsApproval') });
    expect(run()).toMatchObject({ status: 'pending', state: 'awaiting_approval', approved_by: null, approved_at: null });
    expect(approval().status).toBe('pending');
    expect(approval().approvals).toEqual([]);
  });

  it('is not skipped out of the queue while its approval card is still open', async () => {
    seedParkedRun('awaiting_approval');
    actAs(AS_MUM);

    const res = await resolveAutomationRun(RUN, 'skipped');

    expect(res).toEqual({ ok: false, error: english('actions.runWaitsOnItsApproval') });
    expect(run()).toMatchObject({ status: 'pending', approved_by: null });
    expect(approval().status).toBe('pending');
  });

  it('is still refused when its own state no longer says so — the pending approval naming it does', async () => {
    seedParkedRun('queued');
    actAs(AS_MUM);

    const res = await resolveAutomationRun(RUN, 'approved');

    expect(res).toEqual({ ok: false, error: english('actions.runWaitsOnItsApproval') });
    expect(run()).toMatchObject({ status: 'pending', approved_by: null });
    expect(approval().status).toBe('pending');
  });

  it('a failed read of the approval naming it does nothing — it is not "no approval"', async () => {
    seedParkedRun('queued');
    db.client = failingReadsOf('approval_requests');
    actAs(AS_MUM);

    const res = await resolveAutomationRun(RUN, 'approved');

    expect(res).toEqual({ ok: false, error: english('actions.couldNotCheckRunApproval') });
    expect(run()).toMatchObject({ status: 'pending', state: 'queued', approved_by: null, approved_at: null });
    expect(trail()).toEqual([]);
  });

  describe('whose approval has closed while its state never advanced', () => {
    beforeEach(() => {
      seedParkedRun('awaiting_approval');
      const row = store.table('approval_requests')[0] as Record<string, unknown>;
      row.status = 'rejected';
      row.decided_by = DAD;
    });

    it('can still be cleared with Skip — the line is not stuck', async () => {
      actAs(AS_MUM);

      const res = await resolveAutomationRun(RUN, 'skipped');

      expect(res).toEqual({ ok: true, id: RUN });
      expect(run()).toMatchObject({ status: 'skipped', approved_by: 'auth-mum' });
      expect(approval().status).toBe('rejected');
      expect(trail()).toEqual(['skip']);
    });

    it('is not stamped approved: there is no open vote left, and the card said no', async () => {
      actAs(AS_MUM);

      const res = await resolveAutomationRun(RUN, 'approved');

      expect(res).toEqual({ ok: false, error: english('actions.runApprovalAlreadyDecidedSkip') });
      expect(run()).toMatchObject({ status: 'pending', state: 'awaiting_approval', approved_by: null });
      expect(trail()).toEqual([]);
    });
  });
});

describe('what nothing governs', () => {
  it('a concierge line with no approval behind it is carried out, not left "approved" with nothing done', async () => {
    seedFamilyAndPlan();
    seedQueuedPlanRun({ metadata: { plan_id: PLAN, kinds: ['calendar', 'reminder', 'task'], approval_id: null } });
    actAs(AS_MUM);

    const res = await resolveAutomationRun(RUN, 'approved');

    expect(res).toEqual({ ok: true, id: RUN });
    expect(rowsIn('calendar_events')).toHaveLength(1);
    expect(run()).toMatchObject({ status: 'executed', state: 'completed' });
    expect(trail()).toEqual(['approve']);
  });

  it('a run with no plan and no approval still resolves directly', async () => {
    seedFamilyAndPlan();
    store.seed('family_automation_runs', [{
      id: RUN, family_id: FAMILY, trigger_type: 'manual', status: 'pending', state: 'queued',
      summary: 'Water the plants', result: {}, metadata: {}, approved_by: null, approved_at: null, created_by: 'auth-mum',
    }]);
    actAs(AS_DAD);

    const res = await resolveAutomationRun(RUN, 'approved');

    expect(res).toEqual({ ok: true, id: RUN });
    expect(run()).toMatchObject({ status: 'approved', approved_by: 'auth-dad' });
    expect(run().approved_at).toBeTruthy();
    expect(trail()).toEqual(['approve']);
  });

  it('a run someone else resolves between the read and the write is not resolved twice', async () => {
    seedFamilyAndPlan();
    store.seed('family_automation_runs', [{
      id: RUN, family_id: FAMILY, trigger_type: 'manual', status: 'pending', state: 'queued',
      summary: 'Water the plants', result: {}, metadata: {}, approved_by: null, approved_at: null, created_by: 'auth-mum',
    }]);
    db.client = aConcurrentWriteLandsFirst('family_automation_runs', RUN, {
      status: 'skipped', approved_by: 'auth-mum', approved_at: '2026-09-05T10:00:00Z',
    });
    actAs(AS_DAD);

    const res = await resolveAutomationRun(RUN, 'approved');

    expect(res).toEqual({ ok: false, error: english('actions.runNotFoundOrAlready') });
    expect(run()).toMatchObject({ status: 'skipped', approved_by: 'auth-mum', approved_at: '2026-09-05T10:00:00Z' });
    expect(trail()).toEqual([]);
  });

  it('a run that is already done is not rewritten as skipped', async () => {
    seedFamilyAndPlan();
    store.seed('family_automation_runs', [{
      id: RUN, family_id: FAMILY, trigger_type: 'manual', status: 'executed', state: 'completed',
      summary: 'Water the plants', result: {}, metadata: {}, approved_by: 'auth-mum', approved_at: '2026-09-05T10:00:00Z',
      completed_at: '2026-09-05T10:00:00Z', created_by: 'auth-mum',
    }]);
    actAs(AS_DAD);

    const res = await resolveAutomationRun(RUN, 'skipped');

    expect(res.ok).toBe(false);
    expect(run()).toMatchObject({ status: 'executed', state: 'completed', approved_by: 'auth-mum' });
  });
});
