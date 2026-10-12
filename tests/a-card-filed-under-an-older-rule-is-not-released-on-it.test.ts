// AUD-1028-AI-LEGACY — a card is released on the rule it was FILED under, and
// nothing asked whether that rule still holds. The held-step fixes (the rule
// reads the step's bound amount; a deny is not filed as a vote) only reach a
// card filed after them: the executor files a rule only for a step with no
// `approval_id`, it re-weighed only an approver's edit, and `decide()` weighed
// only a recorded edit. So a card filed before them — "one of us", no policy,
// for a bound $900 that "Money needs both of us", or that "Bubaly moves no more
// money than that" refuses — kept its old threshold: one plain yes released it,
// and the step ran with the gate skipped. The same for a card already decided
// on that rule and waiting for the run to resume.
//
// Every release is now weighed against the family's rules as they are, for
// what it runs: `decide()` refuses the yes with nothing written, and the
// executor fails a decided step it may no longer release. A card filed under
// the current rules is released exactly as before — one yes for "one of us",
// both parents for "both of us", everyone for a consensus.
//
// Driven through the real executor port, trust engine, approvals service,
// executeTool and finance service on the in-memory database.
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

const { decide, editAndApprove } = await import('@/lib/services/approvals');
const { executeTool } = await import('@/lib/ai/tools/execute');
const { createExecutorPort, runGraphWith } = await import('@/lib/ai/runs/executor');
const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');

const FAMILY = '00000000-0000-4000-8000-00000000d201';
const DANA = { member: '00000000-0000-4000-8000-00000000d211', user: '00000000-0000-4000-8000-00000000d221' };
const ALEX = { member: '00000000-0000-4000-8000-00000000d212', user: '00000000-0000-4000-8000-00000000d222' };
/** A third manager (an adult), for the household a consensus counts. */
const SAM = { member: '00000000-0000-4000-8000-00000000d213', user: '00000000-0000-4000-8000-00000000d223' };
type Who = typeof DANA | typeof ALEX | typeof SAM;
const REQUEST = '00000000-0000-4000-8000-00000000d231';
const PLAN = '00000000-0000-4000-8000-00000000d232';
const RUN = '00000000-0000-4000-8000-00000000d233';
const COUNT = '00000000-0000-4000-8000-00000000d234';
const BUDGET = '00000000-0000-4000-8000-00000000d235';
const CARD = '00000000-0000-4000-8000-00000000d236';
const NOW = new Date('2026-09-05T12:00:00Z');

const NO_LONGER = translate(SOURCE_MESSAGES, 'approval.ruleNoLongerReleases');
const STEP_NO_LONGER = translate(SOURCE_MESSAGES, 'aiRuns.ruleNoLongerReleases');

const policy = <T extends { id: string }>(over: T) => ({
  family_id: FAMILY, domain: 'finances', capability: 'automate', subject_kind: 'ai', subject_role: null, subject_member_id: null,
  enabled: true, created_at: NOW.toISOString(), updated_at: NOW.toISOString(), approval_model: 'single', required_approvals: 1, ...over,
});
/** "Bubaly may spend up to $50." */
const UP_TO_FIFTY = policy({
  id: '00000000-0000-4000-8000-00000000d241', name: 'Bubaly may spend up to $50', effect: 'allow',
  conditions: { maxAmountCents: 5000 }, priority: 300,
});
/** "Under $50, one of us." */
const UNDER_FIFTY = policy({
  id: '00000000-0000-4000-8000-00000000d242', name: 'Under $50 one of us', effect: 'require_approval',
  conditions: { maxAmountCents: 5000 }, priority: 300,
});
/** "Money needs both of us." */
const BOTH_OF_US = policy({
  id: '00000000-0000-4000-8000-00000000d243', name: 'Money needs both of us', effect: 'require_approval',
  conditions: {}, approval_model: 'two_parent', required_approvals: 2, priority: 200,
});
/** "Bubaly moves no more money than that." */
const NO_MORE = policy({
  id: '00000000-0000-4000-8000-00000000d244', name: 'Bubaly moves no more money than that', effect: 'deny',
  conditions: {}, priority: 200,
});
/** "Money needs all of us." */
const ALL_OF_US = policy({
  id: '00000000-0000-4000-8000-00000000d245', name: 'Money needs all of us', effect: 'require_approval',
  conditions: {}, approval_model: 'consensus', required_approvals: 1, priority: 200,
});

/** "Bubaly may set budgets when it is 95% sure" — an allow a raised confidence would reach. */
const SURE = policy({
  id: '00000000-0000-4000-8000-00000000d246', name: 'Bubaly may set budgets when 95% sure', effect: 'allow',
  conditions: { minConfidence: 0.95 }, priority: 250,
});
/** "Money needs three of us" — a count of approvals, not everyone. */
const THREE_OF_US = policy({
  id: '00000000-0000-4000-8000-00000000d247', name: 'Money needs three of us', effect: 'require_approval',
  conditions: {}, approval_model: 'single', required_approvals: 3, priority: 200,
});
/** "When Bubaly is at least 80% sure, money needs both of us" — stricter the surer it is. */
const SURE_BOTH = policy({
  id: '00000000-0000-4000-8000-00000000d248', name: 'When Bubaly is sure, money needs both of us', effect: 'require_approval',
  conditions: { minConfidence: 0.8 }, approval_model: 'two_parent', required_approvals: 2, priority: 400,
});
/** "When Bubaly is at least 80% sure, it moves no money" — a refusal a confidence switches on. */
const SURE_NO = policy({
  id: '00000000-0000-4000-8000-00000000d249', name: 'When Bubaly is sure, it moves no money', effect: 'deny',
  conditions: { minConfidence: 0.8 }, priority: 400,
});

let db: InMemorySupabase;
const client = () => db as unknown as SupabaseClient<Database>;
const asParent = (who: Who): ServiceScope => ({
  db: client(), familyId: FAMILY, userId: who.user, memberId: who.member, role: 'parent', actorKind: 'member', tz: 'America/New_York',
});
const asAdult = (who: Who): ServiceScope => ({ ...asParent(who), role: 'adult' });
const assistantFor = (who: Who): ServiceScope => ({
  db: client(), familyId: FAMILY, userId: who.user, memberId: who.member, role: 'parent', actorKind: 'ai', tz: 'America/New_York', now: NOW,
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
  db.seed('families', [{ id: FAMILY, name: 'The Okafors', timezone: 'America/New_York' }]);
  db.seed('family_members', [
    { id: DANA.member, family_id: FAMILY, user_id: DANA.user, role: 'parent', is_active: true, display_name: 'Dana' },
    { id: ALEX.member, family_id: FAMILY, user_id: ALEX.user, role: 'parent', is_active: true, display_name: 'Alex' },
  ]);
  db.seed('family_ai_settings', [{ family_id: FAMILY, enabled: true, behavior: 'execute' }]);
  db.seed('budgets', [{ id: 'budget-groceries', family_id: FAMILY, category: 'Groceries', amount: 400, period: 'monthly', created_at: '2026-01-01T00:00:00Z' }]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

const BOUND = { category: 'Groceries', amount: { $fromStep: COUNT, path: 'count' } };
type Rule = { approval_model: string; required_approvals: number; policy_id: string | null };
/** What the executor filed before the held-step rule read a bound amount (or a deny): "one of us", no policy. */
const OLD_RULE: Rule = { approval_model: 'single', required_approvals: 1, policy_id: null };

/** Dana's run: an earlier step that produced `{ count }`, then the held budget step. */
function seedRun(count: number, budget: Record<string, unknown> = {}): void {
  db.seed('ai_requests', [{ id: REQUEST, family_id: FAMILY, requested_by: DANA.user, requested_by_member_id: DANA.member, kind: 'concierge', request_text: 'Set the groceries budget', status: 'executing' }]);
  db.seed('ai_plans', [{ id: PLAN, family_id: FAMILY, request_id: REQUEST, version: 1, status: 'approved', risk_level: 'high' }]);
  const base = {
    family_id: FAMILY, plan_id: PLAN, condition: null, approval_id: null, risk_level: 'high',
    retry_count: 0, max_retries: 2, error: null, started_at: null,
  };
  db.seed('ai_plan_steps', [
    {
      ...base, id: COUNT, sequence: 0, step_type: 'retrieve', tool_name: 'finances.listTransactions', description: 'Add up the month',
      input_json: {}, dependency_ids: [], status: 'completed', approval_required: false,
      result_json: { summary: 'Counted.', count }, completed_at: NOW.toISOString(),
    },
    {
      ...base, id: BUDGET, sequence: 1, step_type: 'act', tool_name: 'finances.updateBudget', description: 'Set the Groceries budget',
      input_json: BOUND, dependency_ids: [COUNT], status: 'ready', approval_required: true,
      result_json: null, completed_at: null, ...budget,
    },
  ]);
  db.seed('family_automation_runs', [{
    id: RUN, family_id: FAMILY, plan_id: PLAN, request_id: REQUEST, run_type: 'concierge', state: 'ready',
    status: 'pending', requested_by_member_id: DANA.member, attempt: 1, max_attempts: 5, lease_owner: 'worker-1',
    lease_expires_at: '2099-01-01T00:00:00Z', cancel_requested_at: null, paused_at: null, progress: {}, created_by: DANA.user,
  }]);
}

/**
 * A run whose held step is already parked on a card filed under `rule`,
 * exactly as the executor's `requestApproval` writes one — pending, or decided
 * by Alex's yes (or `voters`' yeses) and waiting for the run to resume.
 */
function seedParkedCard(count: number, rule: Rule, decided = false, voters: { who: Who; role: string }[] = [{ who: ALEX, role: 'parent' }]): void {
  seedRun(count, { status: 'awaiting_approval', approval_id: CARD });
  db.seed('approval_requests', [{
    id: CARD, family_id: FAMILY, domain: 'finances', capability: 'automate', ...rule,
    requested_by_kind: 'ai', requested_by_member_id: DANA.member, agent: 'concierge', title: 'Set the Groceries budget', summary: null,
    payload: { kind: 'plan_steps', run_id: RUN, step_ids: [BUDGET], input: BOUND }, payload_kind: 'plan_steps',
    run_id: RUN, request_id: REQUEST, plan_step_id: BUDGET, plan_step_ids: [BUDGET], confidence: null, priority: 'high',
    consequences: [], status: decided ? 'approved' : 'pending',
    ...(decided ? {
      approvals: voters.map(({ who, role }) => ({ member_id: who.member, decision: 'approved', note: null, at: NOW.toISOString(), role })),
      decided_by: voters[voters.length - 1].who.member, decided_at: NOW.toISOString(),
    } : {}),
  }]);
}

/**
 * A standalone card Bubaly's tool gate filed for Dana's assistant, with the
 * filing line the gate writes (`filedByBubaly`), before the gate read amounts:
 * "Under $50, one of us" matched a $900 it read as nothing. A line written
 * before the gate recorded a confidence carries none; `filing` adds one.
 */
function seedToolCard(amount: number, rule: Rule, filing: { confidence?: number | null } = {}): void {
  db.seed('approval_requests', [{
    id: CARD, family_id: FAMILY, domain: 'finances', capability: 'automate', ...rule,
    requested_by_kind: 'ai', requested_by_member_id: DANA.member, agent: 'Bubaly', title: 'Set the Groceries budget', summary: null,
    payload: { name: 'finances.updateBudget', args: { category: 'Groceries', amount } }, payload_kind: 'tool',
    run_id: null, request_id: null, plan_step_id: null, plan_step_ids: [], confidence: 0.85, priority: 'normal',
    consequences: [], status: 'pending',
  }]);
  db.seed('trust_audit_logs', [{
    id: `audit-${CARD}`, family_id: FAMILY, actor_kind: 'ai_agent', actor_id: 'bubaly', approval_id: CARD, decision: 'require_approval',
    ...filing,
  }]);
}

/** Sam, an adult, joins the household as its third manager. */
function samJoins(): void {
  db.seed('family_members', [{ id: SAM.member, family_id: FAMILY, user_id: SAM.user, role: 'adult', is_active: true, display_name: 'Sam' }]);
}

const runOnce = () => runGraphWith(createExecutorPort(client()), RUN, { budgetMs: 60_000 });
const budgetStep = () => db.table('ai_plan_steps').find((s) => s.id === BUDGET)!;
const approvalRow = (id: string) => db.table('approval_requests').find((r) => r.id === id)!;
const groceries = () => db.table('budgets').find((b) => b.id === 'budget-groceries')!;

describe('a held card filed "one of us" for a bound $900, before the rule read it', () => {
  for (const [label, rules] of [
    ['“Money needs both of us”', [UP_TO_FIFTY, BOTH_OF_US]],
    ['“Bubaly moves no more money than that”', [UP_TO_FIFTY, NO_MORE]],
  ] as const) {
    describe(`under ${label}`, () => {
      it('a plain yes is refused, nothing is written, and nothing runs', async () => {
        db.seed('trust_policies', [...rules]);
        seedParkedCard(900, OLD_RULE);

        const res = await decide(asParent(ALEX), CARD, 'approved');

        expect(res).toMatchObject({ ok: false, code: 'denied', error: NO_LONGER });
        expect(approvalRow(CARD)).toMatchObject({ status: 'pending', approvals: [] });
        await runOnce();
        expect(budgetStep()).toMatchObject({ status: 'awaiting_approval' });
        expect(groceries()).toMatchObject({ amount: 400 });
        expect(db.table('ai_tool_calls')).toEqual([]);
      });

      it('a card decided on that rule before this check is not run when the run resumes', async () => {
        db.seed('trust_policies', [...rules]);
        seedParkedCard(900, OLD_RULE, true);

        await runOnce();

        expect(budgetStep()).toMatchObject({ status: 'failed', error: STEP_NO_LONGER });
        expect(groceries()).toMatchObject({ amount: 400 });
        expect(db.table('ai_tool_calls'), 'a stale yes ran with the gate skipped').toEqual([]);
      });

      it('a decline still goes through, and cancels the step', async () => {
        db.seed('trust_policies', [...rules]);
        seedParkedCard(900, OLD_RULE);

        expect(await decide(asParent(ALEX), CARD, 'rejected')).toMatchObject({ ok: true, data: { status: 'rejected' } });
        await runOnce();
        expect(budgetStep()).toMatchObject({ status: 'cancelled' });
        expect(groceries()).toMatchObject({ amount: 400 });
      });
    });
  }
});

describe('a standalone card the tool gate filed "one of us" for $900, before it read amounts', () => {
  for (const [label, rules] of [
    ['“Money needs both of us”', [UNDER_FIFTY, BOTH_OF_US]],
    ['“Bubaly moves no more money than that”', [UNDER_FIFTY, NO_MORE]],
  ] as const) {
    it(`under ${label}, a plain yes is refused and the budget is unchanged`, async () => {
      db.seed('trust_policies', [...rules]);
      seedToolCard(900, { approval_model: 'single', required_approvals: 1, policy_id: UNDER_FIFTY.id });

      const res = await decide(asParent(ALEX), CARD, 'approved');

      expect(res).toMatchObject({ ok: false, code: 'denied', error: NO_LONGER });
      expect(approvalRow(CARD)).toMatchObject({ status: 'pending', approvals: [] });
      expect(approvalRow(CARD).executed_at ?? null, 'stamped as executed').toBeNull();
      expect(groceries()).toMatchObject({ amount: 400 });
      expect(db.table('ai_tool_calls')).toEqual([]);
    });
  }
});

// #1028 review (RV-1028-CONF): the release check read the row's `confidence`,
// a pending-row column any manager may rewrite (0251; 0381/0389/0480 do not pin
// it). Raising it let a "when 95% sure" allow release a stale card one yes. The
// confidence a card is weighed at now comes from where it was filed: the
// executor's fixed value for a held step, the gate's filing line for a card.
describe('a raised confidence does not release a stale card', () => {
  it('a gate-filed $900 card: the manager raises its confidence, and a plain yes is still refused', async () => {
    db.seed('trust_policies', [UNDER_FIFTY, BOTH_OF_US, SURE]);
    seedToolCard(900, { approval_model: 'single', required_approvals: 1, policy_id: UNDER_FIFTY.id });
    approvalRow(CARD).confidence = 0.99;

    const res = await decide(asParent(ALEX), CARD, 'approved');

    expect(res).toMatchObject({ ok: false, code: 'denied', error: NO_LONGER });
    expect(approvalRow(CARD)).toMatchObject({ status: 'pending', approvals: [] });
    expect(groceries()).toMatchObject({ amount: 400 });
    expect(db.table('ai_tool_calls')).toEqual([]);
  });

  it('a held-step $900 card: the manager raises its confidence, and a plain yes is still refused', async () => {
    db.seed('trust_policies', [UP_TO_FIFTY, BOTH_OF_US, SURE]);
    seedParkedCard(900, OLD_RULE);
    approvalRow(CARD).confidence = 0.99;

    const res = await decide(asParent(ALEX), CARD, 'approved');

    expect(res).toMatchObject({ ok: false, code: 'denied', error: NO_LONGER });
    expect(approvalRow(CARD)).toMatchObject({ status: 'pending', approvals: [] });
    expect(groceries()).toMatchObject({ amount: 400 });
  });

  it('a gate-filed $40 card filed under today\'s rules still releases on one yes (positive control)', async () => {
    db.seed('trust_policies', [UNDER_FIFTY, BOTH_OF_US, SURE]);
    seedToolCard(40, { approval_model: 'single', required_approvals: 1, policy_id: UNDER_FIFTY.id });
    approvalRow(CARD).confidence = 0.99;

    expect(await decide(asParent(ALEX), CARD, 'approved')).toMatchObject({ ok: true });
    expect(groceries()).toMatchObject({ amount: 40 });
  });
});

// #1028 review (AUD-1028-AI-CONFIDENCE): a filing line with no confidence was
// read as 0. The engine applies `minConfidence` to a deny or a "both of us" as
// readily as to an allow, so 0 hid a rule that tightens when Bubaly is sure —
// and the gate files at 0.85 unless told otherwise. A card whose filing
// confidence is unknown must now hold at every confidence that matters.
describe('a card filed at a confidence nobody recorded is weighed at every one that matters', () => {
  for (const [label, filing] of [
    ['whose filing line carries no confidence', {}],
    ['whose filing line recorded a null confidence', { confidence: null }],
  ] as const) {
    for (const [rule, sure] of [
      ['“when Bubaly is sure, money needs both of us”', SURE_BOTH],
      ['“when Bubaly is sure, it moves no money”', SURE_NO],
    ] as const) {
      it(`a $40 card ${label}, under ${rule}: a plain yes is refused and nothing runs`, async () => {
        db.seed('trust_policies', [UNDER_FIFTY, sure]);
        seedToolCard(40, { approval_model: 'single', required_approvals: 1, policy_id: UNDER_FIFTY.id }, filing);

        const res = await decide(asParent(ALEX), CARD, 'approved');

        expect(res, 'released on one yes a card today’s rule may send to both parents, or refuse').toMatchObject({ ok: false, code: 'denied', error: NO_LONGER });
        expect(approvalRow(CARD)).toMatchObject({ status: 'pending', approvals: [] });
        expect(groceries()).toMatchObject({ amount: 400 });
        expect(db.table('ai_tool_calls')).toEqual([]);
      });
    }
  }

  it('an edit of such a card is weighed at every one too, and refused', async () => {
    db.seed('trust_policies', [UNDER_FIFTY, SURE_BOTH]);
    seedToolCard(40, { approval_model: 'single', required_approvals: 1, policy_id: UNDER_FIFTY.id });

    const res = await editAndApprove(asParent(ALEX), CARD, { amount: 45 });

    expect(res).toMatchObject({ ok: false, code: 'denied', error: translate(SOURCE_MESSAGES, 'approval.editOutsideFiledRule') });
    expect(approvalRow(CARD)).toMatchObject({ status: 'pending', approvals: [], edited_payload: null });
    expect(groceries()).toMatchObject({ amount: 400 });
  });

  it('a filing line that recorded 0.85 is weighed at 0.85: refused under the same rule (control)', async () => {
    db.seed('trust_policies', [UNDER_FIFTY, SURE_BOTH]);
    seedToolCard(40, { approval_model: 'single', required_approvals: 1, policy_id: UNDER_FIFTY.id }, { confidence: 0.85 });

    expect(await decide(asParent(ALEX), CARD, 'approved')).toMatchObject({ ok: false, code: 'denied', error: NO_LONGER });
    expect(groceries()).toMatchObject({ amount: 400 });
  });

  it('a filing line that recorded 0.5 is weighed at 0.5, as filed: one yes still releases it (positive control)', async () => {
    db.seed('trust_policies', [UNDER_FIFTY, SURE_BOTH, SURE_NO]);
    seedToolCard(40, { approval_model: 'single', required_approvals: 1, policy_id: UNDER_FIFTY.id }, { confidence: 0.5 });
    // The row's own column is any manager's to rewrite; the filing line is not.
    approvalRow(CARD).confidence = 0.99;

    expect(await decide(asParent(ALEX), CARD, 'approved')).toMatchObject({ ok: true, data: { status: 'approved', executed: true } });
    expect(groceries()).toMatchObject({ amount: 40 });
  });

  it('a card the tool gate files today under the same rule asks both parents and runs on the second yes (positive control)', async () => {
    db.seed('trust_policies', [UNDER_FIFTY, SURE_BOTH]);
    const outcome = await executeTool(assistantFor(DANA), 'finances.updateBudget', { category: 'Groceries', amount: 40 });
    const card = String((outcome as { approvalId: string }).approvalId);
    expect(approvalRow(card)).toMatchObject({ approval_model: 'two_parent', policy_id: SURE_BOTH.id });

    expect(await decide(asParent(DANA), card, 'approved')).toMatchObject({ ok: true, data: { status: 'pending' } });
    expect(await decide(asParent(ALEX), card, 'approved')).toMatchObject({ ok: true, data: { status: 'approved', executed: true } });
    expect(groceries()).toMatchObject({ amount: 40 });
  });
});

// #1028 review (AUD-1028-AI-QUORUM): a consensus needs everyone who can vote,
// and the household changes. The release check compared a consensus as if the
// family had one manager, and the run executor resuming a decided card looked
// at neither the household nor the votes. Which membership governs is now
// decided by when the release is weighed (lib/trust/edit-rule.ts):
//  - a PENDING card is released by a yes in decide(), which counts the votes
//    against the managers the family has now — so that is what the card is
//    weighed at against today's rule;
//  - a DECIDED card carries the decision decide() took: the yeses it recorded.
//    A member who joined since is not asked again, one who left still voted,
//    and today's rule is compared with the votes the card has.
describe('a consensus card after the household changes', () => {
  const ALL_OF_US_RULE: Rule = { approval_model: 'consensus', required_approvals: 1, policy_id: ALL_OF_US.id };

  describe('pending: the managers the family has when it votes govern', () => {
    it('grew to three under “all of us”: the card waits for all three, then runs (control)', async () => {
      db.seed('trust_policies', [UP_TO_FIFTY, ALL_OF_US]);
      seedParkedCard(900, ALL_OF_US_RULE);
      samJoins();

      expect(await decide(asParent(DANA), CARD, 'approved')).toMatchObject({ ok: true, data: { status: 'pending' } });
      expect(await decide(asParent(ALEX), CARD, 'approved')).toMatchObject({ ok: true, data: { status: 'pending' } });
      await runOnce();
      expect(groceries()).toMatchObject({ amount: 400 });
      expect(await decide(asAdult(SAM), CARD, 'approved')).toMatchObject({ ok: true, data: { status: 'approved' } });
      await runOnce();
      expect(budgetStep()).toMatchObject({ status: 'completed' });
      expect(groceries()).toMatchObject({ amount: 900 });
    });

    it('grew to three, and the family now asks “three of us”: the card needs all three yeses, and releases on them', async () => {
      db.seed('trust_policies', [UP_TO_FIFTY, THREE_OF_US]);
      seedParkedCard(900, ALL_OF_US_RULE);
      samJoins();

      expect(await decide(asParent(DANA), CARD, 'approved'), 'a consensus of three was weighed as one').toMatchObject({ ok: true, data: { status: 'pending' } });
      expect(await decide(asParent(ALEX), CARD, 'approved')).toMatchObject({ ok: true, data: { status: 'pending' } });
      await runOnce();
      expect(groceries()).toMatchObject({ amount: 400 });
      expect(await decide(asAdult(SAM), CARD, 'approved')).toMatchObject({ ok: true, data: { status: 'approved' } });
      await runOnce();
      expect(budgetStep()).toMatchObject({ status: 'completed' });
      expect(groceries()).toMatchObject({ amount: 900 });
    });

    it('shrank to two under “three of us”: a consensus of two asks less, and a yes is refused (control)', async () => {
      db.seed('trust_policies', [UP_TO_FIFTY, THREE_OF_US]);
      samJoins();
      seedParkedCard(900, ALL_OF_US_RULE);
      db.table('family_members').find((m) => m.id === SAM.member)!.is_active = false;

      expect(await decide(asParent(DANA), CARD, 'approved')).toMatchObject({ ok: false, code: 'denied', error: NO_LONGER });
      expect(approvalRow(CARD)).toMatchObject({ status: 'pending', approvals: [] });
      await runOnce();
      expect(groceries()).toMatchObject({ amount: 400 });
    });

    it('shrank to two under “all of us”: the two who remain release it (control)', async () => {
      db.seed('trust_policies', [UP_TO_FIFTY, ALL_OF_US]);
      samJoins();
      seedParkedCard(900, ALL_OF_US_RULE);
      db.table('family_members').find((m) => m.id === SAM.member)!.is_active = false;

      expect(await decide(asParent(DANA), CARD, 'approved')).toMatchObject({ ok: true, data: { status: 'pending' } });
      expect(await decide(asParent(ALEX), CARD, 'approved')).toMatchObject({ ok: true, data: { status: 'approved' } });
      await runOnce();
      expect(groceries()).toMatchObject({ amount: 900 });
    });
  });

  describe('decided: the yeses the decision was taken on govern, not who the household has when the run resumes', () => {
    const DANA_AND_ALEX = [{ who: DANA, role: 'parent' }, { who: ALEX, role: 'parent' }];
    const ALL_THREE = [...DANA_AND_ALEX, { who: SAM, role: 'adult' }];

    it('both managers said yes, then a third joined: under “all of us” the run still runs it (control)', async () => {
      db.seed('trust_policies', [UP_TO_FIFTY, ALL_OF_US]);
      seedParkedCard(900, ALL_OF_US_RULE, true, DANA_AND_ALEX);
      samJoins();

      await runOnce();
      expect(budgetStep()).toMatchObject({ status: 'completed' });
      expect(groceries()).toMatchObject({ amount: 900 });
    });

    it('both managers said yes, then a third joined: under “three of us” two yeses are not three, and it does not run (control)', async () => {
      db.seed('trust_policies', [UP_TO_FIFTY, THREE_OF_US]);
      seedParkedCard(900, ALL_OF_US_RULE, true, DANA_AND_ALEX);
      samJoins();

      await runOnce();
      expect(budgetStep(), 'today’s household lent the card a yes it never had').toMatchObject({ status: 'failed', error: STEP_NO_LONGER });
      expect(groceries()).toMatchObject({ amount: 400 });
      expect(db.table('ai_tool_calls')).toEqual([]);
    });

    it('all three said yes, then one left: under “three of us” the three recorded yeses release it', async () => {
      db.seed('trust_policies', [UP_TO_FIFTY, THREE_OF_US]);
      samJoins();
      seedParkedCard(900, ALL_OF_US_RULE, true, ALL_THREE);
      db.table('family_members').find((m) => m.id === SAM.member)!.is_active = false;

      await runOnce();
      expect(budgetStep(), 'a decided consensus was weighed as one yes').toMatchObject({ status: 'completed' });
      expect(groceries()).toMatchObject({ amount: 900 });
    });
  });
});

describe('a card filed under the rules as they are is released as before (positive controls)', () => {
  it('a bound $20 card filed "one of us" releases on one yes and runs', async () => {
    db.seed('trust_policies', [UP_TO_FIFTY, BOTH_OF_US]);
    seedParkedCard(20, OLD_RULE);

    expect(await decide(asParent(ALEX), CARD, 'approved')).toMatchObject({ ok: true, data: { status: 'approved' } });
    await runOnce();
    expect(budgetStep()).toMatchObject({ status: 'completed' });
    expect(groceries()).toMatchObject({ amount: 20 });
  });

  it('a bound $20 card already decided runs when the run resumes', async () => {
    db.seed('trust_policies', [UP_TO_FIFTY, NO_MORE]);
    seedParkedCard(20, OLD_RULE, true);

    await runOnce();
    expect(budgetStep()).toMatchObject({ status: 'completed' });
    expect(groceries()).toMatchObject({ amount: 20 });
  });

  it('a bound $900 card filed "both of us" waits for the second parent, then runs', async () => {
    db.seed('trust_policies', [UP_TO_FIFTY, BOTH_OF_US]);
    seedParkedCard(900, { approval_model: 'two_parent', required_approvals: 2, policy_id: BOTH_OF_US.id });

    expect(await decide(asParent(DANA), CARD, 'approved')).toMatchObject({ ok: true, data: { status: 'pending', executed: false } });
    await runOnce();
    expect(groceries()).toMatchObject({ amount: 400 });
    expect(await decide(asParent(ALEX), CARD, 'approved')).toMatchObject({ ok: true, data: { status: 'approved' } });
    await runOnce();
    expect(budgetStep()).toMatchObject({ status: 'completed' });
    expect(groceries()).toMatchObject({ amount: 900 });
  });

  it('a card the executor files today under a consensus rule runs once everyone has said yes', async () => {
    db.seed('trust_policies', [UP_TO_FIFTY, ALL_OF_US]);
    seedRun(900);

    await runOnce();
    expect(budgetStep()).toMatchObject({ status: 'awaiting_approval' });
    const card = String(budgetStep().approval_id);
    expect(approvalRow(card)).toMatchObject({ approval_model: 'consensus', policy_id: ALL_OF_US.id });

    expect(await decide(asParent(DANA), card, 'approved')).toMatchObject({ ok: true, data: { status: 'pending' } });
    await runOnce();
    expect(groceries()).toMatchObject({ amount: 400 });
    expect(await decide(asParent(ALEX), card, 'approved')).toMatchObject({ ok: true, data: { status: 'approved' } });
    await runOnce();
    expect(groceries()).toMatchObject({ amount: 900 });
  });

  it('a $40 card the tool gate files today "one of us" releases on one yes', async () => {
    db.seed('trust_policies', [UNDER_FIFTY, BOTH_OF_US]);
    const outcome = await executeTool(assistantFor(DANA), 'finances.updateBudget', { category: 'Groceries', amount: 40 });
    expect(outcome.status).toBe('pending_approval');
    const card = String((outcome as { approvalId: string }).approvalId);
    expect(approvalRow(card)).toMatchObject({ approval_model: 'single', policy_id: UNDER_FIFTY.id });

    expect(await decide(asParent(ALEX), card, 'approved')).toMatchObject({ ok: true, data: { status: 'approved', executed: true } });
    expect(groceries()).toMatchObject({ amount: 40 });
  });

  it('a $900 card the tool gate files today "both of us" runs on the second parent’s yes', async () => {
    db.seed('trust_policies', [UNDER_FIFTY, BOTH_OF_US]);
    const outcome = await executeTool(assistantFor(DANA), 'finances.updateBudget', { category: 'Groceries', amount: 900 });
    const card = String((outcome as { approvalId: string }).approvalId);
    expect(approvalRow(card)).toMatchObject({ approval_model: 'two_parent', policy_id: BOTH_OF_US.id });

    expect(await decide(asParent(DANA), card, 'approved')).toMatchObject({ ok: true, data: { status: 'pending' } });
    expect(await decide(asParent(ALEX), card, 'approved')).toMatchObject({ ok: true, data: { status: 'approved', executed: true } });
    expect(groceries()).toMatchObject({ amount: 900 });
  });
});
