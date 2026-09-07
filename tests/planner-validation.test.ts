// The validator is where a model reply becomes something the executor can be
// trusted with. Each case here is a way a plan can be wrong and what happens
// to it: an invented tool, arguments the tool rejects, a dependency loop, a
// write the household forbids. The second half drives `planRequest` end to
// end against a fake ledger with the scripted provider, and proves the two
// promises the map's P2-02 definition of done makes: "Plan our week" persists
// a plan whose steps name only registry tools with their approval flags set,
// and a `recommend` household gets a recommendation and no run — with no
// trust_audit_logs or approval_requests row written while planning.
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ContextBundle } from '@/lib/ai/context/builder';
import type { AIProvider } from '@/lib/ai/provider';
import type { Policy } from '@/lib/trust/engine';
import type { ServiceScope } from '@/lib/services/types';
import { buildRepairMessage, toolsForIntent } from '@/lib/ai/planner/prompts';
import { encodeStepInput, type Plan, type PlanStep } from '@/lib/ai/planner/schema';
import { autonomyBehaviorFor, catalogueNames, dominantBehavior, dryRunGate, maxRisk, resolveFollowupAt, validatePlan, type ValidationInputs } from '@/lib/ai/planner/validate';
import { getTool, listTools } from '@/lib/ai/tools/registry';
import { loadScripts, ScriptedProvider } from '@/lib/ai/provider-stub';

const ledgerHolder = vi.hoisted(() => ({ client: null as SupabaseClient<Database> | null }));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => {
    if (!ledgerHolder.client) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured');
    return ledgerHolder.client;
  },
}));

const { planRequest, PLANNER_PROMPT_VERSION } = await import('@/lib/ai/planner/index');

const NOW = new Date('2026-09-05T16:00:00Z');

/** The whole registry is the catalogue unless a case narrows it: these tests are about everything else the validator does. */
function inputsWith(extra: Partial<ValidationInputs> = {}): ValidationInputs {
  return { policies: [], grants: [], delegations: [], emergencyDomains: [], role: 'parent', now: NOW, tz: 'America/New_York', allowedTools: catalogueNames(listTools()), ...extra };
}

/** The catalogue the planner offers an intent — the set the validator must enforce. */
function catalogueFor(intent: Parameters<typeof toolsForIntent>[0]): ReadonlySet<string> {
  return catalogueNames(toolsForIntent(intent, listTools()));
}

function step(partial: Partial<PlanStep> & { key: string }): PlanStep {
  return {
    step_type: 'retrieve', tool_name: null, description: partial.key, input: '{}', depends_on: [], condition: null, approval_required: null, verify: null,
    ...partial,
  };
}

function plan(steps: PlanStep[], extra: Partial<Plan> = {}): Plan {
  return { objective: 'Test', reasoning_summary: 'Because.', risk_level: 'low', steps, followups: [], clarification: null, answer: null, ...extra };
}

const aiPolicy = (domain: string, effect: Policy['effect'], priority = 10): Policy => ({
  id: `p-${domain}-${effect}`, domain, capability: 'all', subjectKind: 'ai', subjectRole: null, subjectMemberId: null,
  effect, conditions: {}, approvalModel: 'single', requiredApprovals: 1, priority, enabled: true,
});

describe('validatePlan: tools and inputs', () => {
  it('drops a step that names a tool the registry does not have, and its dependents', () => {
    const result = validatePlan(plan([
      step({ key: 'a', step_type: 'act', tool_name: 'finances.transferMoney', input: '{"amount":10}' }),
      step({ key: 'b', step_type: 'notify', input: '{"recipients":"family","type":"system","title":"Done"}', depends_on: ['a'] }),
      step({ key: 'c', step_type: 'retrieve', tool_name: 'family.listMembers' }),
    ]), inputsWith());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.steps.map((s) => s.key)).toEqual(['c']);
    expect(result.issues.map((i) => i.code)).toEqual(['unknown_tool', 'dependency_dropped']);
  });

  it('resolves legacy aliases and underscored names to the canonical tool', () => {
    const result = validatePlan(plan([
      step({ key: 'a', step_type: 'act', tool_name: 'create_calendar_event', input: '{"title":"Dentist","starts_at":"2026-09-07T09:00:00"}' }),
      step({ key: 'b', step_type: 'act', tool_name: 'tasks_createTodo', input: '{"title":"Pack"}' }),
    ]), inputsWith());
    expect(result.ok && result.steps.map((s) => s.toolName)).toEqual(['calendar.createEvent', 'tasks.createTodo']);
  });

  it('drops a step whose arguments the tool schema rejects, quoting the field', () => {
    const result = validatePlan(plan([
      step({ key: 'a', step_type: 'act', tool_name: 'calendar.createEvent', input: '{"title":"Dentist"}' }),
      step({ key: 'ok', step_type: 'retrieve', tool_name: 'family.listMembers' }),
    ]), inputsWith());
    expect(result.ok && result.steps.map((s) => s.key)).toEqual(['ok']);
    const issue = result.issues.find((i) => i.code === 'invalid_input');
    expect(issue?.message).toContain('starts_at');
  });

  it('treats a strict-mode null as an absent optional field, like the executor does', () => {
    const result = validatePlan(plan([
      step({ key: 'a', step_type: 'act', tool_name: 'calendar.createEvent', input: '{"title":"Dentist","starts_at":"2026-09-07T09:00:00","ends_at":null,"category":null}' }),
    ]), inputsWith());
    // `.nullish()` fields keep their null (the tool accepts it); a `.optional()` field would have been dropped.
    expect(result.ok && result.steps[0].input).toMatchObject({ title: 'Dentist', starts_at: '2026-09-07T09:00:00', ends_at: null });
    expect(result.ok && result.steps).toHaveLength(1);
  });

  it('drops a step with input that is not a JSON object, and a step with no tool', () => {
    const result = validatePlan(plan([
      step({ key: 'a', step_type: 'act', tool_name: 'tasks.createTodo', input: 'not json' }),
      step({ key: 'b', step_type: 'act', tool_name: null, input: '{}' }),
      step({ key: 'c', step_type: 'retrieve', tool_name: 'family.listMembers', input: '' }),
    ]), inputsWith());
    expect(result.ok && result.steps.map((s) => s.key)).toEqual(['c']);
    expect(result.issues.map((i) => i.code)).toEqual(['invalid_input', 'missing_tool']);
  });

  it('corrects a step type that disagrees with the tool', () => {
    const result = validatePlan(plan([
      step({ key: 'a', step_type: 'act', tool_name: 'family.listMembers' }),
      step({ key: 'b', step_type: 'retrieve', tool_name: 'tasks.createTodo', input: '{"title":"Pack"}' }),
    ]), inputsWith());
    expect(result.ok && result.steps.map((s) => s.stepType)).toEqual(['retrieve', 'act']);
    expect(result.issues.filter((i) => i.code === 'type_coerced')).toHaveLength(2);
  });

  it('keeps the second of two steps with the same key out', () => {
    const result = validatePlan(plan([
      step({ key: 'a', tool_name: 'family.listMembers' }),
      step({ key: 'a', tool_name: 'family.getPreferences' }),
    ]), inputsWith());
    expect(result.ok && result.steps).toHaveLength(1);
    expect(result.issues[0].code).toBe('duplicate_key');
  });
});

describe('validatePlan: the intent catalogue', () => {
  it('drops a real tool that is outside the intent\'s catalogue, and its dependents, as off_catalogue', () => {
    // documents.readDocument exists, but a meal plan is never offered it (prompts.ts INTENT_TOOL_DOMAINS).
    expect(getTool('documents.readDocument')).not.toBeNull();
    expect(catalogueFor('plan_meals').has('documents.readDocument')).toBe(false);
    const steps = [
      step({ key: 'a', step_type: 'retrieve', tool_name: 'documents.readDocument', input: '{"document_id":"doc-1"}' }),
      step({ key: 'b', step_type: 'notify', input: '{"recipients":"family","type":"system","title":"Done"}', depends_on: ['a'] }),
      step({ key: 'c', step_type: 'retrieve', tool_name: 'family.listMembers' }),
    ];
    const narrowed = validatePlan(plan(steps), inputsWith({ allowedTools: catalogueFor('plan_meals') }));
    expect(narrowed.ok && narrowed.steps.map((s) => s.key)).toEqual(['c']);
    expect(narrowed.issues.map((i) => i.code)).toEqual(['off_catalogue', 'dependency_dropped']);
    expect(narrowed.issues[0].message).toContain('documents.readDocument');
    expect(narrowed.issues[0].message).toMatch(/catalogue/);
    // The same plan under an intent that offers documents keeps the step: the catalogue, not the registry, decides.
    const offered = validatePlan(plan(steps), inputsWith({ allowedTools: catalogueFor('prepare_vacation') }));
    expect(offered.ok && offered.steps.map((s) => s.key)).toEqual(['a', 'b', 'c']);
    expect(offered.issues.map((i) => i.code)).not.toContain('off_catalogue');
  });

  it('resolves an alias to its canonical tool before checking the catalogue', () => {
    const steps = [step({ key: 'a', step_type: 'act', tool_name: 'create_calendar_event', input: '{"title":"Dentist","starts_at":"2026-09-07T09:00:00"}' })];
    // spending_review is not offered the calendar; plan_meals is.
    const refused = validatePlan(plan(steps), inputsWith({ allowedTools: catalogueFor('spending_review') }));
    expect(refused.ok).toBe(false);
    expect(refused.issues.map((i) => i.code)).toEqual(['off_catalogue', 'empty']);
    const kept = validatePlan(plan(steps), inputsWith({ allowedTools: catalogueFor('plan_meals') }));
    expect(kept.ok && kept.steps.map((s) => s.toolName)).toEqual(['calendar.createEvent']);
  });

  it('the repair turn tells the model the catalogue is a boundary', () => {
    expect(buildRepairMessage(['Step "a" names documents.readDocument, which is not in the catalogue for this request.'])).toMatch(/off-catalogue .* will be dropped/);
  });
});

describe('validatePlan: the graph', () => {
  it('rejects a dependency cycle outright', () => {
    const result = validatePlan(plan([
      step({ key: 'a', tool_name: 'family.listMembers', depends_on: ['b'] }),
      step({ key: 'b', tool_name: 'family.getPreferences', depends_on: ['a'] }),
    ]), inputsWith());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('cycle');
    expect(result.error).toMatch(/loop/);
  });

  it('removes a dependency on a key that never existed but keeps the step', () => {
    const result = validatePlan(plan([
      step({ key: 'a', tool_name: 'family.listMembers', depends_on: ['ghost'] }),
    ]), inputsWith());
    expect(result.ok && result.steps[0].dependsOn).toEqual([]);
    expect(result.issues[0].code).toBe('unknown_dependency');
  });

  it('expands a verify slot into a verify step behind its act step', () => {
    const result = validatePlan(plan([
      step({ key: 'a', step_type: 'act', tool_name: 'tasks.createTodo', input: '{"title":"Pack"}', verify: '{"checks":[{"kind":"count_at_least","table":"todo_items","min":1}]}' }),
    ]), inputsWith());
    expect(result.ok && result.steps.map((s) => [s.key, s.stepType, s.dependsOn])).toEqual([['a', 'act', []], ['a__verify', 'verify', ['a']]]);
  });

  it('ignores a verify slot Bubaly cannot check but keeps the step', () => {
    const result = validatePlan(plan([
      step({ key: 'a', step_type: 'act', tool_name: 'tasks.createTodo', input: '{"title":"Pack"}', verify: '{"checks":[{"kind":"records_exist","table":"users","ids":["x"]}]}' }),
    ]), inputsWith());
    expect(result.ok && result.steps.map((s) => s.key)).toEqual(['a']);
    expect(result.issues[0].code).toBe('invalid_verify');
  });

  it('drops a notify step with nothing to send and a verify step with no checks', () => {
    const result = validatePlan(plan([
      step({ key: 'n', step_type: 'notify', input: '{"recipients":"family"}' }),
      step({ key: 'v', step_type: 'verify', input: '{"checks":[]}' }),
      step({ key: 'ok', tool_name: 'family.listMembers' }),
    ]), inputsWith());
    expect(result.ok && result.steps.map((s) => s.key)).toEqual(['ok']);
    expect(result.issues.map((i) => i.code)).toEqual(['invalid_notify', 'invalid_verify']);
  });

  it('appends follow-ups behind every leaf, in time order, each followed by a note to the parents', () => {
    const result = validatePlan(plan([
      step({ key: 'read', tool_name: 'family.listMembers' }),
      step({ key: 'act', step_type: 'act', tool_name: 'tasks.createTodo', input: '{"title":"Pack"}', depends_on: ['read'] }),
      step({ key: 'tell', step_type: 'notify', input: '{"recipients":"family","type":"system","title":"Done"}', depends_on: ['act'] }),
    ], { followups: [{ after: '2d', prompt: 'Second check' }, { after: '12h', prompt: 'First check' }] }), inputsWith());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const keys = result.steps.map((s) => s.key);
    expect(keys).toEqual(['read', 'act', 'tell', 'followup_1', 'followup_1__notify', 'followup_2', 'followup_2__notify']);
    const first = result.steps.find((s) => s.key === 'followup_1')!;
    expect(first.dependsOn).toEqual(['tell']);
    expect(first.input).toEqual({ runAfter: new Date(NOW.getTime() + 12 * 3_600_000).toISOString() });
    expect(result.steps.find((s) => s.key === 'followup_1__notify')!.input).toMatchObject({ recipients: 'managers', body: 'First check' });
    expect(result.steps.find((s) => s.key === 'followup_2')!.dependsOn).toEqual(['followup_1__notify']);
  });

  it('drops a follow-up in the past or with a time it cannot read', () => {
    const result = validatePlan(plan([
      step({ key: 'read', tool_name: 'family.listMembers' }),
    ], { followups: [{ after: '2020-01-01T00:00:00Z', prompt: 'old' }, { after: 'whenever', prompt: 'vague' }] }), inputsWith());
    expect(result.ok && result.steps.map((s) => s.key)).toEqual(['read']);
    expect(result.issues.map((i) => i.code).sort()).toEqual(['invalid_followup', 'past_followup']);
  });

  it('resolves relative, family-local and absolute follow-up times', () => {
    expect(resolveFollowupAt('45m', NOW, 'America/New_York')).toBe(new Date(NOW.getTime() + 45 * 60_000).toISOString());
    expect(resolveFollowupAt('2d', NOW, 'America/New_York')).toBe(new Date(NOW.getTime() + 2 * 86_400_000).toISOString());
    // 09:00 New York on 10 Sep 2026 is 13:00 UTC (EDT).
    expect(resolveFollowupAt('2026-09-10T09:00:00', NOW, 'America/New_York')).toBe('2026-09-10T13:00:00.000Z');
    expect(resolveFollowupAt('2026-09-10T09:00:00Z', NOW, 'America/New_York')).toBe('2026-09-10T09:00:00.000Z');
    expect(resolveFollowupAt('soon', NOW, 'America/New_York')).toBeNull();
  });

  it('fails a plan with nothing runnable', () => {
    const result = validatePlan(plan([step({ key: 'a', step_type: 'act', tool_name: 'nope' })]), inputsWith());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('empty');
  });
});

describe('validatePlan: risk and the pure trust dry run', () => {
  it('sets each step\'s risk from its tool and the plan\'s risk to the maximum', () => {
    const result = validatePlan(plan([
      step({ key: 'r', tool_name: 'family.listMembers' }),
      step({ key: 'low', step_type: 'act', tool_name: 'tasks.createTodo', input: '{"title":"Pack"}' }),
      step({ key: 'high', step_type: 'act', tool_name: 'calendar.deleteEvent', input: '{"event_id":"ev-1"}' }),
    ]), inputsWith());
    expect(result.ok && result.steps.map((s) => s.riskLevel)).toEqual(['low', 'low', 'high']);
    expect(result.ok && result.riskLevel).toBe('high');
    expect(maxRisk(['low', 'medium'])).toBe('medium');
  });

  it('marks a high-risk write approval-required and a low-risk one free, for a parent with no policies', () => {
    const result = validatePlan(plan([
      step({ key: 'low', step_type: 'act', tool_name: 'tasks.createTodo', input: '{"title":"Pack"}' }),
      step({ key: 'high', step_type: 'act', tool_name: 'calendar.deleteEvent', input: '{"event_id":"ev-1"}' }),
    ]), inputsWith());
    expect(result.ok && result.steps.map((s) => s.approvalRequired)).toEqual([false, true]);
    expect(result.ok && result.requiresApproval).toBe(true);
    expect(result.ok && result.steps[1].decisionReason).toMatch(/big change/);
  });

  it('honours the model\'s own approval flag', () => {
    const result = validatePlan(plan([
      step({ key: 'low', step_type: 'act', tool_name: 'tasks.createTodo', input: '{"title":"Pack"}', approval_required: true }),
    ]), inputsWith());
    expect(result.ok && result.steps[0].approvalRequired).toBe(true);
  });

  it('holds every write when the household behaviour is prepare, even the low-risk ones', () => {
    const result = validatePlan(plan([
      step({ key: 'read', tool_name: 'family.listMembers' }),
      step({ key: 'low', step_type: 'act', tool_name: 'tasks.createTodo', input: '{"title":"Pack"}' }),
      step({ key: 'ev', step_type: 'act', tool_name: 'calendar.createEvent', input: '{"title":"Dentist","starts_at":"2026-09-07T09:00:00"}' }),
    ]), inputsWith({ policies: [aiPolicy('all', 'require_approval')] }));
    expect(result.ok && result.steps.map((s) => s.approvalRequired)).toEqual([false, true, true]);
    expect(result.ok && result.behavior).toBe('prepare');
  });

  it('keeps recommend-only writes out of execution and reports the plan as recommend', () => {
    const result = validatePlan(plan([
      step({ key: 'read', tool_name: 'family.listMembers' }),
      step({ key: 'meal', step_type: 'act', tool_name: 'meals.setSlot', input: '{"date":"2026-09-07","meal_name":"Tacos"}' }),
      step({ key: 'tell', step_type: 'notify', input: '{"recipients":"family","type":"system","title":"Dinner"}', depends_on: ['meal'] }),
    ]), inputsWith({ policies: [aiPolicy('meal_planning', 'deny')] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.steps.map((s) => s.key)).toEqual(['read']);
    expect(result.recommendOnly.map((s) => s.key)).toEqual(['meal']);
    expect(result.issues.map((i) => i.code)).toEqual(['recommend_only', 'dependency_dropped']);
  });

  it('reads the behaviour per domain from the ai policies, most specific and highest priority first', () => {
    const policies = [aiPolicy('all', 'require_approval', 1), aiPolicy('calendar', 'allow', 10), aiPolicy('finances', 'deny', 10)];
    expect(autonomyBehaviorFor(policies, 'calendar')).toBe('execute');
    expect(autonomyBehaviorFor(policies, 'finances')).toBe('recommend');
    expect(autonomyBehaviorFor(policies, 'tasks')).toBe('prepare');
    expect(autonomyBehaviorFor([], 'tasks')).toBeNull();
    expect(dominantBehavior(['execute', null, 'prepare'])).toBe('prepare');
    expect(dominantBehavior([null])).toBeNull();
  });

  it('mirrors the executor for a child: a sensitive read and an unautomatable write are left out, a high-risk write waits for a parent', () => {
    // These are the executor's own answers (evaluateAction → riskToDecision):
    // a child may not read finances through any tool; a child's role has no
    // `automate` capability so a plain create is refused; and the high-risk
    // tier turns that refusal into "a person decides" for a delete.
    const result = validatePlan(plan([
      step({ key: 'money', step_type: 'retrieve', tool_name: 'finances.budgetVsActual', input: '{"month":"2026-09"}' }),
      step({ key: 'del', step_type: 'act', tool_name: 'calendar.deleteEvent', input: '{"event_id":"ev-1"}' }),
      step({ key: 'todo', step_type: 'act', tool_name: 'tasks.createTodo', input: '{"title":"Homework"}' }),
    ]), inputsWith({ role: 'child' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.steps.map((s) => [s.key, s.approvalRequired])).toEqual([['del', true]]);
    expect(result.issues.filter((i) => i.code === 'denied').map((i) => i.step)).toEqual(['money', 'todo']);
    expect(result.issues.find((i) => i.step === 'money')?.message).toMatch(/private to the adults/);
  });

  it('when a refusal is the only thing that happened, the refusal is the answer', () => {
    // A teen asking "why did we spend so much" produces a plan that is money
    // all the way down. Every step is denied, nothing is left, and what came
    // back was "The plan has no step Bubaly can run." — which reads as a fault
    // in Bubaly and tells the person nothing about what to do instead. The
    // reason was already computed one function away.
    const allMoney = validatePlan(plan([
      step({ key: 'budget', step_type: 'retrieve', tool_name: 'finances.budgetVsActual', input: '{"month":"2026-09"}' }),
      step({ key: 'cats', step_type: 'retrieve', tool_name: 'finances.spendingByCategory', input: '{"from":"2026-09-01","to":"2026-09-30"}' }),
    ]), inputsWith({ role: 'teen' }));
    expect(allMoney).toMatchObject({ ok: false, code: 'empty' });
    expect(allMoney.ok).toBe(false);
    if (allMoney.ok) return;
    expect(allMoney.error).toMatch(/private to the adults/);
    expect(allMoney.error).not.toMatch(/no step Bubaly can run/);
    // One sentence, not one per denied step: both steps were refused for the
    // same reason and a person should read it once.
    expect(allMoney.error.match(/private to the adults/g)).toHaveLength(1);

    // The generic line still covers the case it was written for — a plan that
    // simply fell apart, with nothing refused.
    const nonsense = validatePlan(plan([
      step({ key: 'ghost', step_type: 'act', tool_name: 'finances.transferMoney', input: '{}' }),
    ]), inputsWith());
    expect(nonsense).toMatchObject({ ok: false, code: 'empty' });
    if (nonsense.ok) return;
    expect(nonsense.error).toBe('The plan has no step Bubaly can run.');
  });

  it('reads the family’s own dial, not just their trust policies', () => {
    // §11's autonomy dial lives in `family_ai_settings`, which the Trust
    // policies table has never mirrored. The planner read only the policies,
    // so a family who set Meals to "Recommend only" in Settings → Bubaly AI
    // got a plan whose act steps were neither dropped nor held for a yes.
    const settings = {
      familyId: 'fam-1', enabled: true, behavior: 'execute' as const,
      categoryBehavior: { meal_planning: 'recommend' as const },
      riskOverrides: {}, childChannels: {}, memoryEnabled: true, quietHours: null,
    };
    const one = plan([step({ key: 'meal', step_type: 'act', tool_name: 'meals.setSlot', input: '{"date":"2026-09-07","slot":"dinner","title":"Tacos"}' })]);

    // Same plan, same family, the only difference being the dial.
    const asIs = validatePlan(one, inputsWith());
    expect(asIs.ok && asIs.steps.map((s) => s.key)).toEqual(['meal']);

    const dialled = validatePlan(one, inputsWith({ settings }));
    // Nothing left to execute — which is what "Recommend only" means, and why
    // the planner hands it back as a recommendation instead.
    expect(dialled).toMatchObject({ ok: false, code: 'empty' });
    expect(dialled.issues.find((i) => i.step === 'meal')?.code).toBe('recommend_only');
  });

  it('takes the stricter of the two when a family has expressed both', () => {
    const settings = {
      familyId: 'fam-1', enabled: true, behavior: 'prepare' as const, categoryBehavior: {},
      riskOverrides: {}, childChannels: {}, memoryEnabled: true, quietHours: null,
    };
    const result = validatePlan(plan([
      step({ key: 'todo', step_type: 'act', tool_name: 'tasks.createTodo', input: '{"title":"Homework"}' }),
    ]), inputsWith({ settings }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // "Prepare" stages the work rather than dropping it.
    expect(result.steps.map((s) => [s.key, s.approvalRequired])).toEqual([['todo', true]]);
  });

  it('drops a step that uses a result it does not depend on', () => {
    // The executor resolves `$fromStep` against the DEPENDENCY results it has
    // in hand, so this binding is unresolvable by construction — it would fail
    // at execution, after the plan looked fine to everyone who read it.
    const result = validatePlan(plan([
      step({ key: 'trip', step_type: 'act', tool_name: 'trips.findOrCreateVacation', input: '{"title":"Maine"}' }),
      step({
        key: 'pack', step_type: 'act', tool_name: 'trips.createPackingList',
        input: '{"vacation_id":{"$fromStep":"trip","path":"id"}}',
        depends_on: [],
      }),
    ]), inputsWith());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.steps.map((s) => s.key)).toEqual(['trip']);
    const issue = result.issues.find((i) => i.step === 'pack');
    expect(issue?.code).toBe('invalid_input');
    expect(issue?.message).toContain('without depending on it');
  });

  it('keeps the same step when it does depend on what it reads', () => {
    const result = validatePlan(plan([
      step({ key: 'trip', step_type: 'act', tool_name: 'trips.findOrCreateVacation', input: '{"title":"Maine"}' }),
      step({
        key: 'pack', step_type: 'act', tool_name: 'trips.createPackingList',
        input: '{"vacation_id":{"$fromStep":"trip","path":"id"}}',
        depends_on: ['trip'],
      }),
    ]), inputsWith());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.steps.map((s) => s.key)).toEqual(['trip', 'pack']);
  });

  it('mirrors the executor gate: a household allow policy beats the risk tier', () => {
    const tool = getTool('calendar.deleteEvent')!;
    const withoutPolicy = dryRunGate(tool, { event_id: 'x' }, inputsWith(), null);
    expect(withoutPolicy).toMatchObject({ effect: 'require_approval', basis: 'risk_tier', capability: 'automate' });
    const withPolicy = dryRunGate(tool, { event_id: 'x' }, inputsWith({ policies: [aiPolicy('calendar', 'allow')] }), 'execute');
    expect(withPolicy).toMatchObject({ effect: 'allow', basis: 'policy' });
    const read = dryRunGate(getTool('family.listMembers')!, {}, inputsWith(), null);
    expect(read.skipped).toBe(true);
  });
});

// ── planRequest end to end against a fake ledger ────────────────────────────

type Row = Record<string, unknown>;
type Call = { table: string; kind: 'select' | 'insert' | 'update' | 'upsert' | 'delete'; payload?: unknown; filters: Record<string, unknown>; returning?: boolean };

/**
 * A PostgREST fake that accepts any builder chain, records every write, and
 * answers reads from a table map. Inserts that end in `.select().single()`
 * return a generated id, which is what `savePlan`/`createRun` read back.
 */
function makeLedger(tables: Record<string, Row[]> = {}) {
  const calls: Call[] = [];
  let counter = 0;
  const from = (table: string) => {
    const call: Call = { table, kind: 'select', filters: {} };
    calls.push(call);
    const rows = () => tables[table] ?? [];
    const reply = () => {
      if (call.kind === 'insert') {
        const payload = call.payload as Row | Row[];
        const first = Array.isArray(payload) ? payload[0] : payload;
        return { data: { id: (first?.id as string) ?? `${table}-${++counter}` }, error: null };
      }
      return { data: rows(), error: null };
    };
    const one = () => (call.kind === 'select' ? { data: rows()[0] ?? null, error: null } : reply());
    const builder: Record<string, unknown> = {};
    const proxy: unknown = new Proxy(builder, {
      get(_target, prop: string) {
        if (prop === 'then') return (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => Promise.resolve(
          call.kind === 'select' ? { data: rows(), error: null }
            // `.update().select()` answers with the rows it touched, like PostgREST;
            // this recorder does not track state, so it reports the targeted row as matched.
            : call.kind === 'update' && call.returning ? { data: [{ id: call.filters['eq:id'] ?? 'row-1' }], error: null }
              : { data: null, error: null },
        ).then(resolve, reject);
        if (prop === 'select') return () => { call.returning = true; return proxy; };
        if (prop === 'single' || prop === 'maybeSingle') return () => Promise.resolve(one());
        if (prop === 'insert' || prop === 'update' || prop === 'upsert') return (payload: unknown) => { call.kind = prop; call.payload = payload; return proxy; };
        if (prop === 'delete') return () => { call.kind = 'delete'; return proxy; };
        return (...args: unknown[]) => {
          if (['eq', 'in', 'is', 'gt', 'gte', 'lt', 'lte'].includes(prop) && typeof args[0] === 'string') call.filters[`${prop}:${args[0]}`] = args[args.length - 1];
          return proxy;
        };
      },
    });
    return proxy;
  };
  return { db: { from } as unknown as SupabaseClient<Database>, calls };
}

function scopeWith(db: SupabaseClient<Database>, extra: Partial<ServiceScope> = {}): ServiceScope {
  return { db, familyId: 'fam-1', userId: 'auth-1', memberId: 'mem-parent', role: 'parent', actorKind: 'member', tz: 'America/New_York', now: NOW, ...extra };
}

function bundle(): ContextBundle {
  return {
    header: { familyName: 'The Riveras', tz: 'America/New_York', locale: 'en-US', currency: 'USD', nowIso: NOW.toISOString(), todayKey: '2026-09-05', viewerRole: 'parent', viewerName: 'Dana' },
    slices: { people: { members: [{ id: 'mem-parent', name: 'Dana', role: 'parent', canManage: true }, { id: 'mem-child', name: 'Maya', role: 'child', canManage: false }] } },
    stats: { people_count: 2 },
    sensitiveOmitted: [],
    text: 'Family: The Riveras\nMembers: Dana (parent), Maya (child)\nSoccer practice Wednesday 4pm.',
  };
}

async function scripted(): Promise<AIProvider> {
  return new ScriptedProvider('tests/ai-eval/scripts', await loadScripts('tests/ai-eval/scripts'));
}

const TRUST_TABLES = ['trust_policies', 'permission_grants', 'trust_delegations', 'emergency_sessions'];

describe('planRequest with the scripted provider', () => {
  it('"Plan our week" persists a plan whose steps name only registry tools, with approval flags, and a ready run', async () => {
    const ledger = makeLedger({ ai_requests: [{ id: 'req-1', prompt_tokens: 0, completion_tokens: 0, latency_ms: 0, clarifications: [] }] });
    const trust = makeLedger();
    const result = await planRequest(scopeWith(trust.db), {
      requestId: 'req-1', requestText: 'Plan our week', intent: 'plan_week', context: bundle(),
    }, { provider: await scripted(), db: ledger.db, now: NOW });

    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    if (!result.ok) return;
    expect(result.data.kind).toBe('plan');
    if (result.data.kind !== 'plan') return;
    expect(result.data.runId).toBe('family_automation_runs-2');
    expect(result.data.riskLevel).toBe('medium');

    const planInsert = ledger.calls.find((c) => c.table === 'ai_plans' && c.kind === 'insert')!;
    expect(planInsert.payload).toMatchObject({ family_id: 'fam-1', request_id: 'req-1', planner_prompt_version: PLANNER_PROMPT_VERSION, planner_model: 'scripted-stub', status: 'approved' });

    const stepsInsert = ledger.calls.find((c) => c.table === 'ai_plan_steps' && c.kind === 'insert')!;
    const rows = stepsInsert.payload as Row[];
    expect(rows.length).toBe(result.data.stepCount);
    for (const row of rows) {
      expect(row.family_id).toBe('fam-1');
      if (row.step_type === 'act' || row.step_type === 'retrieve') expect(getTool(String(row.tool_name)), String(row.tool_name)).not.toBeNull();
      expect(typeof row.approval_required).toBe('boolean');
    }
    // meals.planWeek is medium risk; a parent with no policies runs it unasked — and the reads never ask.
    expect(rows.filter((r) => r.step_type === 'retrieve').every((r) => r.approval_required === false)).toBe(true);
    expect(rows.some((r) => r.key === undefined)).toBe(true); // rows carry ids, not planner keys
    expect(rows.map((r) => r.step_type)).toContain('verify');
    expect(rows.map((r) => r.step_type)).toContain('followup');

    const runInsert = ledger.calls.find((c) => c.table === 'family_automation_runs' && c.kind === 'insert')!;
    expect(runInsert.payload).toMatchObject({ family_id: 'fam-1', request_id: 'req-1', plan_id: 'ai_plans-1', state: 'ready', run_type: 'concierge' });
    expect(ledger.calls.find((c) => c.table === 'ai_run_events' && c.kind === 'insert')!.payload).toMatchObject({ event_type: 'planned', family_id: 'fam-1' });

    const requestUpdates = ledger.calls.filter((c) => c.table === 'ai_requests' && c.kind === 'update').map((c) => (c.payload as Row).status).filter(Boolean);
    expect(requestUpdates).toEqual(['planning', 'ready']);
    expect(ledger.calls.filter((c) => c.table === 'ai_requests' && c.kind === 'update').every((c) => c.filters['eq:family_id'] === 'fam-1')).toBe(true);
  });

  it('never writes a trust audit row or an approval row while planning', async () => {
    const ledger = makeLedger({ ai_requests: [{ id: 'req-1', prompt_tokens: 0, completion_tokens: 0, latency_ms: 0, clarifications: [] }] });
    const trust = makeLedger();
    const result = await planRequest(scopeWith(trust.db), {
      requestId: 'req-1', requestText: 'Plan our week', intent: 'plan_week', context: bundle(),
    }, { provider: await scripted(), db: ledger.db, now: NOW });
    expect(result.ok).toBe(true);

    const writes = [...ledger.calls, ...trust.calls].filter((c) => c.kind !== 'select');
    expect(writes.map((c) => c.table)).not.toContain('trust_audit_logs');
    expect(writes.map((c) => c.table)).not.toContain('approval_requests');
    // The trust inputs were read exactly once each, through the requester's client.
    for (const table of TRUST_TABLES) expect(trust.calls.filter((c) => c.table === table && c.kind === 'select')).toHaveLength(1);
  });

  it('with behaviour = recommend, writes a pending recommendation and no plan or run', async () => {
    const ledger = makeLedger({ ai_requests: [{ id: 'req-2', prompt_tokens: 0, completion_tokens: 0, latency_ms: 0, clarifications: [] }] });
    const trust = makeLedger({
      trust_policies: [{ id: 'p-1', family_id: 'fam-1', name: 'AI autonomy: everything', domain: 'all', capability: 'all', subject_kind: 'ai', effect: 'deny', conditions: {}, approval_model: 'single', required_approvals: 1, priority: 10, enabled: true }],
    });
    const result = await planRequest(scopeWith(trust.db), {
      requestId: 'req-2', requestText: 'Plan our week', intent: 'plan_week', context: bundle(),
    }, { provider: await scripted(), db: ledger.db, now: NOW });

    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    if (!result.ok) return;
    expect(result.data.kind).toBe('recommendation');
    if (result.data.kind !== 'recommendation') return;
    expect(result.data.summary).toMatch(/planned dinners/i);

    const rec = ledger.calls.find((c) => c.table === 'family_ai_recommendations' && c.kind === 'insert')!;
    expect(rec.payload).toMatchObject({ family_id: 'fam-1', status: 'pending', source: 'concierge', category: 'chief_of_staff', member_id: 'mem-parent' });
    expect(String((rec.payload as Row).body)).toContain('What Bubaly would do');
    expect(ledger.calls.some((c) => c.table === 'ai_plans' && c.kind === 'insert')).toBe(false);
    expect(ledger.calls.some((c) => c.table === 'family_automation_runs')).toBe(false);
    expect(ledger.calls.filter((c) => c.table === 'ai_requests' && c.kind === 'update').map((c) => (c.payload as Row).status).filter(Boolean)).toEqual(['planning', 'completed']);
  });

  it('with behaviour = prepare, every write step waits for approval and the plan says so', async () => {
    const ledger = makeLedger({ ai_requests: [{ id: 'req-3', prompt_tokens: 0, completion_tokens: 0, latency_ms: 0, clarifications: [] }] });
    const trust = makeLedger({
      trust_policies: [{ id: 'p-1', family_id: 'fam-1', name: 'AI autonomy: everything', domain: 'all', capability: 'all', subject_kind: 'ai', effect: 'require_approval', conditions: {}, approval_model: 'single', required_approvals: 1, priority: 10, enabled: true }],
    });
    const result = await planRequest(scopeWith(trust.db), {
      requestId: 'req-3', requestText: 'Plan our week', intent: 'plan_week', context: bundle(),
    }, { provider: await scripted(), db: ledger.db, now: NOW });
    expect(result.ok && result.data.kind === 'plan' && result.data.requiresApproval).toBe(true);
    const rows = ledger.calls.find((c) => c.table === 'ai_plan_steps' && c.kind === 'insert')!.payload as Row[];
    expect(rows.filter((r) => r.step_type === 'act').every((r) => r.approval_required === true)).toBe(true);
    expect(rows.filter((r) => r.step_type !== 'act').every((r) => r.approval_required === false)).toBe(true);
    expect(ledger.calls.find((c) => c.table === 'ai_plans' && c.kind === 'insert')!.payload).toMatchObject({ requires_approval: true });
  });

  it('a pure question becomes an answer, completes the request and creates nothing', async () => {
    const ledger = makeLedger({ ai_requests: [{ id: 'req-4', prompt_tokens: 0, completion_tokens: 0, latency_ms: 0, clarifications: [] }] });
    const result = await planRequest(scopeWith(makeLedger().db), {
      requestId: 'req-4', requestText: 'When is soccer practice?', intent: 'answer_question', context: bundle(),
    }, { provider: await scripted(), db: ledger.db, now: NOW });
    expect(result.ok && result.data).toMatchObject({ kind: 'answer', text: expect.stringContaining('Wednesday') });
    expect(ledger.calls.some((c) => c.table === 'ai_plans')).toBe(false);
    expect(ledger.calls.filter((c) => c.table === 'ai_requests' && c.kind === 'update').map((c) => (c.payload as Row).status).filter(Boolean)).toEqual(['planning', 'completed']);
  });

  it('a clarification is persisted on the request and parks it at awaiting_context', async () => {
    const question = { question: 'Which trip do you mean — Disney in October or the lake in November?', reason: 'The packing lists and dates differ.' };
    const provider = {
      id: 'fake', model: 'gpt-4.1',
      complete: async () => { throw new Error('unused'); },
      runTools: async () => { throw new Error('unused'); },
      runToolsStream: async function* () { throw new Error('unused'); },
      structuredCompletion: async () => ({ text: JSON.stringify(plan([], { clarification: question })), refusal: null, usage: null }),
    } as unknown as AIProvider;
    const ledger = makeLedger({ ai_requests: [{ id: 'req-5', prompt_tokens: 0, completion_tokens: 0, latency_ms: 0, clarifications: [{ question: 'Earlier?', reason: null, asked_at: '2026-09-01T00:00:00Z', answer: 'yes', answered_at: '2026-09-01T00:01:00Z' }] }] });
    const result = await planRequest(scopeWith(makeLedger().db), {
      requestId: 'req-5', requestText: 'Get us ready for the trip', intent: 'prepare_vacation', context: bundle(),
    }, { provider, db: ledger.db, now: NOW });
    expect(result.ok && result.data).toEqual({ kind: 'clarification', question: question.question, requestId: 'req-5' });
    const parked = ledger.calls.filter((c) => c.table === 'ai_requests' && c.kind === 'update').map((c) => c.payload as Row).find((p) => p.status === 'awaiting_context')!;
    expect(parked.clarifications).toHaveLength(2);
    expect((parked.clarifications as Row[])[1]).toMatchObject({ question: question.question, reason: question.reason, answer: null, asked_at: NOW.toISOString() });
  });

  it('gives the model one repair round when the plan cannot run, then fails the request honestly', async () => {
    const bad = plan([step({ key: 'a', step_type: 'act', tool_name: 'finances.transferMoney', input: '{}' })]);
    const replies = [bad, bad];
    let calls = 0;
    const provider = {
      id: 'fake', model: 'gpt-4.1',
      complete: async () => { throw new Error('unused'); },
      runTools: async () => { throw new Error('unused'); },
      runToolsStream: async function* () { throw new Error('unused'); },
      structuredCompletion: async (input: { messages: { role: string; content: string }[] }) => {
        calls += 1;
        if (calls === 2) expect(input.messages.at(-1)?.content).toMatch(/does not exist/);
        return { text: JSON.stringify(replies.shift()), refusal: null, usage: null };
      },
    } as unknown as AIProvider;
    const ledger = makeLedger({ ai_requests: [{ id: 'req-6', prompt_tokens: 0, completion_tokens: 0, latency_ms: 0, clarifications: [] }] });
    const result = await planRequest(scopeWith(makeLedger().db), {
      requestId: 'req-6', requestText: 'Move money', intent: 'other', context: bundle(),
    }, { provider, db: ledger.db, now: NOW });
    expect(calls).toBe(2);
    expect(result.ok).toBe(false);
    expect(ledger.calls.filter((c) => c.table === 'ai_requests' && c.kind === 'update').map((c) => (c.payload as Row).status).filter(Boolean)).toEqual(['planning', 'failed']);
  });

  it('validates against the catalogue it offered: an off-catalogue step is dropped from the persisted plan and noted on the timeline', async () => {
    const reply = plan([
      step({ key: 'peek', step_type: 'retrieve', tool_name: 'documents.readDocument', input: '{"document_id":"doc-1"}' }),
      step({ key: 'who', step_type: 'retrieve', tool_name: 'family.listMembers' }),
      step({ key: 'tell', step_type: 'notify', input: '{"recipients":"family","type":"system","title":"Dinner is planned","body":"See the meal plan."}', depends_on: ['who'] }),
    ]);
    let system = '';
    const provider = {
      id: 'fake', model: 'gpt-4.1',
      complete: async () => { throw new Error('unused'); },
      runTools: async () => { throw new Error('unused'); },
      runToolsStream: async function* () { throw new Error('unused'); },
      structuredCompletion: async (input: { system: string }) => {
        system = input.system;
        return { text: JSON.stringify(reply), refusal: null, usage: null };
      },
    } as unknown as AIProvider;
    const ledger = makeLedger({ ai_requests: [{ id: 'req-8', prompt_tokens: 0, completion_tokens: 0, latency_ms: 0, clarifications: [] }] });
    const result = await planRequest(scopeWith(makeLedger().db), {
      requestId: 'req-8', requestText: 'Plan our meals', intent: 'plan_meals', context: bundle(),
    }, { provider, db: ledger.db, now: NOW });
    expect(result.ok && result.data.kind).toBe('plan');
    // The prompt never offered the tool, and the validator did not accept it either.
    expect(system).not.toContain('documents.readDocument');
    const rows = ledger.calls.find((c) => c.table === 'ai_plan_steps' && c.kind === 'insert')!.payload as Row[];
    expect(rows.map((r) => r.tool_name)).toEqual(['family.listMembers', null]);
    const planned = ledger.calls.find((c) => c.table === 'ai_run_events' && c.kind === 'insert')!.payload as { payload: { adjustments: string[] } };
    expect(planned.payload.adjustments).toContain('off_catalogue');
  });

  it('feeds earlier answers into the prompt and stamps the intent on the prompt so the stub can match it', async () => {
    let seen: { system: string; messages: { content: string }[] } | null = null;
    const provider = {
      id: 'fake', model: 'gpt-4.1',
      complete: async () => { throw new Error('unused'); },
      runTools: async () => { throw new Error('unused'); },
      runToolsStream: async function* () { throw new Error('unused'); },
      structuredCompletion: async (input: { system: string; messages: { content: string }[] }) => {
        seen = input;
        return { text: JSON.stringify(plan([], { answer: 'ok' })), refusal: null, usage: null };
      },
    } as unknown as AIProvider;
    const ledger = makeLedger({ ai_requests: [{ id: 'req-7', prompt_tokens: 0, completion_tokens: 0, latency_ms: 0, clarifications: [] }] });
    await planRequest(scopeWith(makeLedger().db), {
      requestId: 'req-7', requestText: 'Plan our meals', intent: 'plan_meals', context: bundle(), answers: { 'Which week?': 'Next week' },
    }, { provider, db: ledger.db, now: NOW });
    expect(seen).not.toBeNull();
    const call = seen as unknown as { system: string; messages: { content: string }[] };
    expect(call.system).toMatch(/^Intent: plan_meals$/m);
    expect(call.system).toContain('meals.planWeek');
    expect(call.system).not.toContain('trips.buildPlan');
    expect(call.system).not.toContain('documents.readDocument');
    expect(call.messages[0].content).toContain('Which week?: Next week');
    expect(call.messages[0].content).toContain('Soccer practice Wednesday');
    expect(call.messages[0].content).toContain('"key":"plan_dinners"');
  });
});

describe('validatePlan: replan steps', () => {
  const who = step({ key: 'who', tool_name: 'family.listMembers' });
  const decide = (extra: Partial<PlanStep> = {}) => step({ key: 'decide', step_type: 'replan', input: '{"prompt":"Pick the free evening"}', depends_on: ['who'], ...extra });

  it('keeps one replan step that depends on a read, carrying its prompt and never an approval', () => {
    const result = validatePlan(plan([who, decide()]), inputsWith());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.steps.map((s) => s.key)).toEqual(['who', 'decide']);
    expect(result.steps[1]).toMatchObject({ stepType: 'replan', toolName: null, input: { prompt: 'Pick the free evening' }, approvalRequired: false, riskLevel: 'low', dependsOn: ['who'] });
    expect(result.issues).toEqual([]);
  });

  it('falls back to the description when the replan step has no prompt', () => {
    const result = validatePlan(plan([who, decide({ input: '{}', description: 'Decide what the evening needs' })]), inputsWith());
    expect(result.ok && result.steps[1].input).toEqual({ prompt: 'Decide what the evening needs' });
  });

  it('drops a replan step with nothing to decide from: an empty depends_on, or only unknown ones', () => {
    const empty = validatePlan(plan([who, decide({ depends_on: [] })]), inputsWith());
    expect(empty.ok && empty.steps.map((s) => s.key)).toEqual(['who']);
    expect(empty.issues.map((i) => i.code)).toEqual(['invalid_replan']);

    const unknown = validatePlan(plan([who, decide({ depends_on: ['nope'] })]), inputsWith());
    expect(unknown.ok && unknown.steps.map((s) => s.key)).toEqual(['who']);
    expect(unknown.issues.map((i) => i.code)).toEqual(['unknown_dependency', 'invalid_replan']);
  });

  it('drops a second replan step, and anything that depends on a replan step', () => {
    const result = validatePlan(plan([
      who,
      decide(),
      decide({ key: 'decide_again' }),
      step({ key: 'after', step_type: 'act', tool_name: 'tasks.createTodo', input: '{"title":"Pack"}', depends_on: ['decide'] }),
      step({ key: 'tell', step_type: 'notify', input: '{"recipients":"family","type":"system","title":"Done"}', depends_on: ['after'] }),
    ]), inputsWith());
    expect(result.ok && result.steps.map((s) => s.key)).toEqual(['who', 'decide']);
    expect(result.issues.map((i) => i.code)).toEqual(['invalid_replan', 'invalid_replan', 'dependency_dropped']);
    expect(result.issues[1].message).toContain('nothing may');
  });

  it('leaves follow-ups out of a plan that ends in a replan step', () => {
    const result = validatePlan(plan([who, decide()], { followups: [{ after: '2d', prompt: 'Check the evening went well' }] }), inputsWith());
    expect(result.ok && result.steps.map((s) => s.stepType)).toEqual(['retrieve', 'replan']);
    expect(result.issues.map((i) => i.code)).toEqual(['invalid_followup']);
  });
});
