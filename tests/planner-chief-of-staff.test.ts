// The chief-of-staff intent: the request that reaches across the household
// and matches no single workflow ("handle it", "get the house sorted"). Each
// promise here is one the audit found missing (M1): the intent sees the WHOLE
// tool catalogue and every context slice; the recognisers route the phrasing
// to it without stealing the signature workflows; the template is shaped as
// promised — independent reads first, act steps grouped by area behind only
// their own reads, one notification behind everything; the validator's trust
// dry run gates an act step exactly where policy or the risk tier says so and
// nowhere else; and end to end, `planRequest` persists a multi-domain plan
// whose reads the executor runs together before parking at ONE approval gate.
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ContextBundle } from '@/lib/ai/context/builder';
import { classifyIntentFast, INTENT_SLICES, SLICE_NAMES } from '@/lib/ai/context/intents';
import type { AIProvider } from '@/lib/ai/provider';
import { buildPlannerSystemPrompt, INTENT_TOOL_DOMAINS, toolsForIntent } from '@/lib/ai/planner/prompts';
import { parseStepInput, type Plan, type PlanStep } from '@/lib/ai/planner/schema';
import { instantiateTemplate, templateContextFrom, templateFor } from '@/lib/ai/planner/templates/index';
import { catalogueNames, validatePlan, type ValidationInputs } from '@/lib/ai/planner/validate';
import { MAX_STEP_CONCURRENCY, runGraphWith, type ExecutorPort, type RunSnapshot, type StepSnapshot } from '@/lib/ai/runs/executor';
import type { RunEventInput } from '@/lib/ai/runs/store';
import { getTool, listTools } from '@/lib/ai/tools/registry';
import type { ToolOutcome } from '@/lib/ai/tools/types';
import { ok, type ServiceScope } from '@/lib/services/types';
import { TRUST_DOMAINS, type Policy } from '@/lib/trust/engine';

const ledgerHolder = vi.hoisted(() => ({ client: null as SupabaseClient<Database> | null }));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => {
    if (!ledgerHolder.client) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured');
    return ledgerHolder.client;
  },
}));

const { planRequest } = await import('@/lib/ai/planner/index');

const NOW = new Date('2026-09-05T16:00:00Z');
const INTENT = 'chief_of_staff' as const;

function step(partial: Partial<PlanStep> & { key: string }): PlanStep {
  return {
    step_type: 'retrieve', tool_name: null, description: partial.key, input: '{}', depends_on: [], condition: null, approval_required: null, verify: null,
    ...partial,
  };
}

function plan(steps: PlanStep[], extra: Partial<Plan> = {}): Plan {
  return { objective: 'Take care of the week', reasoning_summary: 'The week needs a dentist visit, a form, milk and a tighter grocery budget.', risk_level: 'medium', steps, followups: [], clarification: null, answer: null, ...extra };
}

const aiPolicy = (domain: string, effect: Policy['effect'], priority = 10): Policy => ({
  id: `p-${domain}-${effect}`, domain, capability: 'all', subjectKind: 'ai', subjectRole: null, subjectMemberId: null,
  effect, conditions: {}, approvalModel: 'single', requiredApprovals: 1, priority, enabled: true,
});

function inputsWith(extra: Partial<ValidationInputs> = {}): ValidationInputs {
  return { policies: [], grants: [], delegations: [], emergencyDomains: [], role: 'parent', now: NOW, tz: 'America/New_York', allowedTools: catalogueNames(toolsForIntent(INTENT, listTools())), ...extra };
}

/**
 * A model reply for "take care of the week": four reads across four areas
 * with nothing between them, one act per area behind only its own read, and
 * the notification behind every act. `finances.updateBudget` is the one step
 * the trust dry run must gate (high risk, high-stakes domain) — the single
 * approval gate the executor half of this file waits at.
 */
function multiDomainPlan(): Plan {
  return plan([
    step({ key: 'events', tool_name: 'calendar.searchEvents', input: '{"from":"2026-09-05T16:00:00","to":"2026-09-12T23:59:00","limit":100}' }),
    step({ key: 'todos', tool_name: 'tasks.searchTodos', input: '{"done":false,"limit":50}' }),
    step({ key: 'groceries', tool_name: 'groceries.listOpen', input: '{"limit":50}' }),
    step({ key: 'budget', tool_name: 'finances.budgetVsActual', input: '{"month":"2026-09"}' }),
    step({ key: 'calendar_act', step_type: 'act', tool_name: 'calendar.createEvent', description: 'Book the dentist for Maya', input: '{"title":"Dentist for Maya","starts_at":"2026-09-08T09:00:00"}', depends_on: ['events'] }),
    step({ key: 'tasks_act', step_type: 'act', tool_name: 'tasks.createTodo', description: 'Add the field-trip form', input: '{"title":"Sign the field-trip form"}', depends_on: ['todos'] }),
    step({ key: 'grocery_act', step_type: 'act', tool_name: 'groceries.addItems', description: 'Add milk to the list', input: '{"items":[{"name":"Milk"}]}', depends_on: ['groceries'] }),
    step({ key: 'budget_act', step_type: 'act', tool_name: 'finances.updateBudget', description: 'Tighten the grocery budget', input: '{"category":"Groceries","amount":600}', depends_on: ['budget'] }),
    step({ key: 'tell', step_type: 'notify', description: 'Tell Dana what was done', input: '{"recipients":"managers","type":"system","title":"Your week is handled","body":"Dentist booked, form on the list, milk added; the budget change is waiting on you."}', depends_on: ['calendar_act', 'tasks_act', 'grocery_act', 'budget_act'] }),
  ]);
}

describe('the chief_of_staff intent', () => {
  it('is offered the whole tool catalogue — every trust domain, so every registry tool', () => {
    expect(INTENT_TOOL_DOMAINS.chief_of_staff).toEqual([...TRUST_DOMAINS]);
    const offered = toolsForIntent(INTENT, listTools()).map((t) => t.name).sort();
    expect(offered).toEqual(listTools().map((t) => t.name).sort());
    // Tools no signature workflow sees together are all here.
    for (const name of ['trips.buildPlan', 'documents.readDocument', 'finances.updateBudget', 'home.createMaintenanceTask', 'meals.setSlot', 'school.listHomeworkDue']) {
      expect(offered, name).toContain(name);
    }
  });

  it('loads every context slice, people first, so the plan can reach anywhere the request does', () => {
    expect(INTENT_SLICES.chief_of_staff[0]).toBe('people');
    expect([...INTENT_SLICES.chief_of_staff].sort()).toEqual([...SLICE_NAMES].sort());
  });

  it('is recognised without a model, and only once nothing more specific claimed the text', () => {
    for (const text of ['Handle it for me', 'Take care of everything', 'Sort it all out', 'Get the house sorted', 'Keep us on track', 'Run our household this week']) {
      expect(classifyIntentFast(text, { now: NOW })?.intent, text).toBe(INTENT);
    }
    // The signature workflows still win over the generic sweep.
    expect(classifyIntentFast('Plan our week', { now: NOW })?.intent).toBe('plan_week');
    expect(classifyIntentFast('Remind everyone about the weekend plan', { now: NOW })?.intent).toBe('remind_everyone');
    expect(classifyIntentFast('Are we ready for Monday?', { now: NOW })?.intent).toBe('what_am_i_forgetting');
  });

  it('gets a planner prompt that stamps the intent, lists the whole catalogue and explains the replan step', () => {
    const template = templateFor(INTENT)!;
    const system = buildPlannerSystemPrompt({ intent: INTENT, template, tools: toolsForIntent(INTENT, listTools()), behavior: null, viewerRole: 'parent' });
    expect(system).toMatch(/^Intent: chief_of_staff$/m);
    expect(system).toContain('trips.buildPlan');
    expect(system).toContain('documents.readDocument');
    expect(system).toMatch(/replan = stop and plan the rest/);
    expect(system).toMatch(/At most one per plan/);
  });
});

describe('the chief-of-staff template', () => {
  const ctx = templateContextFrom({
    tz: 'America/New_York', nowIso: NOW.toISOString(), todayKey: '2026-09-05', requestText: 'Handle everything for this week',
    viewerMemberId: 'mem-parent', managerIds: ['mem-parent'],
  });
  const template = templateFor(INTENT)!;
  const skeleton = instantiateTemplate(template, ctx);
  const reads = skeleton.steps.filter((s) => s.step_type === 'retrieve');
  const acts = skeleton.steps.filter((s) => s.step_type === 'act');
  const tells = skeleton.steps.filter((s) => s.step_type === 'notify');

  it('is registered for the intent, owned by the Chief of Staff, and needs the model to fill it', () => {
    expect(template.intent).toBe(INTENT);
    expect(template.agent).toBe('chief_of_staff');
    expect(template.deterministic).toBe(false);
    expect(skeleton.objective).toBe('Handle everything for this week');
  });

  it('reads first, everywhere: many independent reads across at least five areas, all runnable at once', () => {
    expect(reads.length).toBeGreaterThanOrEqual(8);
    for (const read of reads) expect(read.depends_on, read.key).toEqual([]);
    const areas = new Set(reads.map((r) => getTool(r.tool_name!)!.domain));
    expect(areas.size).toBeGreaterThanOrEqual(5);
    // Reads come before every act in plan order, so the executor's first
    // batches are reads and nothing else.
    const lastRead = Math.max(...reads.map((r) => skeleton.steps.indexOf(r)));
    const firstAct = Math.min(...acts.map((a) => skeleton.steps.indexOf(a)));
    expect(lastRead).toBeLessThan(firstAct);
  });

  it('then acts, one step per area, each behind only the reads of its own area', () => {
    const readKeys = new Set(reads.map((r) => r.key));
    const areas = new Set(acts.map((a) => getTool(a.tool_name!)!.domain));
    expect(areas.size).toBeGreaterThanOrEqual(3);
    for (const act of acts) {
      expect(act.depends_on.length, act.key).toBeGreaterThan(0);
      for (const dep of act.depends_on) expect(readKeys.has(dep), `${act.key} → ${dep}`).toBe(true);
    }
    // Areas do not wait on each other: no act depends on every read.
    for (const act of acts) expect(act.depends_on.length, act.key).toBeLessThan(reads.length);
  });

  it('leaves approval to the trust dry run — no skeleton step pre-decides it', () => {
    for (const s of skeleton.steps) expect(s.approval_required, s.key).toBeNull();
    expect(template.guidance.join(' ')).toMatch(/Leave approval_required null/);
  });

  it('ends with one notification to the asker, behind every read and every act', () => {
    expect(tells).toHaveLength(1);
    expect(new Set(tells[0].depends_on)).toEqual(new Set([...reads, ...acts].map((s) => s.key)));
    expect(parseStepInput(tells[0].input)).toMatchObject({ ok: true, value: { recipients: ['mem-parent'] } });
  });
});

describe('the trust dry run over a multi-domain plan', () => {
  it('gates only the step the risk tier demands when the household has no policies', () => {
    const result = validatePlan(multiDomainPlan(), inputsWith());
    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    if (!result.ok) return;
    expect(result.steps).toHaveLength(9);
    const gated = result.steps.filter((s) => s.approvalRequired).map((s) => s.key);
    expect(gated).toEqual(['budget_act']);
    expect(result.steps.filter((s) => s.stepType === 'retrieve').every((s) => s.dependsOn.length === 0 && !s.approvalRequired)).toBe(true);
    expect(result.requiresApproval).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('adds a gate exactly where a household policy asks for one, and nowhere else', () => {
    const result = validatePlan(multiDomainPlan(), inputsWith({ policies: [aiPolicy('shopping', 'require_approval')] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const gated = result.steps.filter((s) => s.approvalRequired).map((s) => s.key).sort();
    expect(gated).toEqual(['budget_act', 'grocery_act']);
    expect(result.steps.find((s) => s.key === 'grocery_act')?.decisionReason).toBeTruthy();
    expect(result.steps.find((s) => s.key === 'calendar_act')?.approvalRequired).toBe(false);
    expect(result.steps.find((s) => s.key === 'tasks_act')?.approvalRequired).toBe(false);
  });
});

// ── planRequest → executor, end to end ─────────────────────────────────────

type Row = Record<string, unknown>;
type Call = { table: string; kind: 'select' | 'insert' | 'update' | 'upsert' | 'delete'; payload?: unknown; filters: Record<string, unknown>; returning?: boolean };

/** A PostgREST fake that accepts any builder chain, records every write, and answers reads from a table map. */
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

function scopeWith(db: SupabaseClient<Database>): ServiceScope {
  return { db, familyId: 'fam-1', userId: 'auth-1', memberId: 'mem-parent', role: 'parent', actorKind: 'member', tz: 'America/New_York', now: NOW };
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

function providerReplying(reply: Plan, seen: { system: string; user: string }): AIProvider {
  return {
    id: 'fake', model: 'gpt-4.1',
    complete: async () => { throw new Error('unused'); },
    runTools: async () => { throw new Error('unused'); },
    runToolsStream: async function* () { throw new Error('unused'); },
    structuredCompletion: async (input: { system: string; messages: { content: string }[] }) => {
      seen.system = input.system;
      seen.user = input.messages[0]?.content ?? '';
      return { text: JSON.stringify(reply), refusal: null, usage: null };
    },
  } as unknown as AIProvider;
}

/** The persisted `ai_plan_steps` rows as the executor would load them. */
function snapshotsFrom(rows: Row[]): StepSnapshot[] {
  return rows.map((r, index) => ({
    id: String(r.id),
    plan_id: String(r.plan_id),
    sequence: Number(r.sequence ?? index),
    step_type: r.step_type as StepSnapshot['step_type'],
    tool_name: (r.tool_name as string | null) ?? null,
    description: (r.description as string | null) ?? null,
    input_json: r.input_json as StepSnapshot['input_json'],
    dependency_ids: r.dependency_ids as string[],
    condition: (r.condition as StepSnapshot['condition']) ?? null,
    status: r.status as StepSnapshot['status'],
    approval_required: Boolean(r.approval_required),
    approval_id: null,
    risk_level: r.risk_level as StepSnapshot['risk_level'],
    retry_count: 0,
    max_retries: Number(r.max_retries ?? 2),
    result_json: null,
    error: null,
  }));
}

type Harness = {
  port: ExecutorPort;
  run: RunSnapshot & Record<string, unknown>;
  steps: StepSnapshot[];
  events: RunEventInput[];
  approvals: Record<string, { status: string }>;
  /** Tool calls in start order, and the most tools ever running at once. */
  calls: string[];
  peak: number;
  step(id: string): StepSnapshot;
};

/** The executor's outside world over the persisted rows: tools answer at once, approvals stay pending until the test decides. */
function harnessFor(steps: StepSnapshot[], planId: string): Harness {
  const scope: ServiceScope = { db: {} as ServiceScope['db'], familyId: 'fam-1', userId: 'auth-1', memberId: 'mem-parent', role: 'parent', actorKind: 'ai', tz: 'America/New_York' };
  let inFlight = 0;
  const h: Harness = {
    port: null as unknown as ExecutorPort,
    run: {
      id: 'run-1', family_id: 'fam-1', plan_id: planId, request_id: 'req-1', state: 'ready', cancel_requested_at: null, paused_at: null,
      requested_by_member_id: 'mem-parent', attempt: 1, max_attempts: 5, lease_owner: 'lease-1',
    },
    steps,
    events: [],
    approvals: {},
    calls: [],
    peak: 0,
    step(id) {
      const found = h.steps.find((s) => s.id === id);
      if (!found) throw new Error(`no step ${id}`);
      return found;
    },
  };
  let now = NOW.getTime();
  h.port = {
    async loadRun() { return ok({ ...h.run }); },
    async loadSteps() { return ok(h.steps.map((s) => ({ ...s }))); },
    async updateRun(_run, patch) { Object.assign(h.run, patch); },
    async updateStep(_run, stepId, patch) { Object.assign(h.step(stepId), patch); },
    async appendEvent(_run, event) { h.events.push(event); },
    async heartbeat() {},
    async scopeFor() { return ok(scope); },
    async runTool(_scope, name, _args, opts) {
      h.calls.push(opts.stepId);
      inFlight += 1;
      h.peak = Math.max(h.peak, inFlight);
      await new Promise((resolve) => { setTimeout(resolve, 0); });
      inFlight -= 1;
      return { status: 'ok', data: { id: `res-${opts.stepId}` }, summary: `did ${name}`, toolCallId: 'tc-1' } as ToolOutcome;
    },
    async requestApproval(_scope, _run, step) {
      const id = `appr-${step.id}`;
      h.approvals[id] = h.approvals[id] ?? { status: 'pending' };
      return ok({ id });
    },
    async loadApproval(_scope, approvalId) {
      const found = h.approvals[approvalId];
      return ok(found ? { id: approvalId, status: found.status, editedPayload: null } : null);
    },
    async notifyFamily() { return ok({ created: 1 }); },
    async verify() { return ok({ verified: true, detail: 'All checks passed.', checks: [] }); },
    replan: null,
    async setRequestState() {},
    now: () => now,
    async sleep(ms) { now += ms; },
    random: () => 0.5,
  };
  return h;
}

describe('planRequest → executor for a multi-domain request', () => {
  it('persists a plan with independent reads, acts across four areas and ONE gate, then runs the reads together and parks at that gate', async () => {
    const ledger = makeLedger({ ai_requests: [{ id: 'req-1', prompt_tokens: 0, completion_tokens: 0, latency_ms: 0, clarifications: [] }] });
    const trust = makeLedger();
    const seen = { system: '', user: '' };
    const result = await planRequest(scopeWith(trust.db), {
      requestId: 'req-1', requestText: 'Handle everything for this week', intent: INTENT, context: bundle(),
    }, { provider: providerReplying(multiDomainPlan(), seen), db: ledger.db, now: NOW });

    // ── Planned: the prompt carried the full catalogue and the skeleton ──
    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    if (!result.ok || result.data.kind !== 'plan') throw new Error('expected a plan');
    expect(result.data).toMatchObject({ stepCount: 9, requiresApproval: true, riskLevel: 'high' });
    expect(seen.system).toMatch(/^Intent: chief_of_staff$/m);
    expect(seen.system).toContain('trips.buildPlan');
    expect(seen.user).toContain('"key":"tell_asker"');

    // ── Persisted: reads independent, acts in four areas, one gate ─────
    const rows = ledger.calls.find((c) => c.table === 'ai_plan_steps' && c.kind === 'insert')!.payload as Row[];
    expect(rows).toHaveLength(9);
    const reads = rows.filter((r) => r.step_type === 'retrieve');
    expect(reads).toHaveLength(4);
    for (const read of reads) expect(read.dependency_ids, String(read.tool_name)).toEqual([]);
    const actRows = rows.filter((r) => r.step_type === 'act');
    expect(new Set(actRows.map((r) => getTool(String(r.tool_name))!.domain))).toEqual(new Set(['calendar', 'tasks', 'shopping', 'finances']));
    const gated = rows.filter((r) => r.approval_required === true);
    expect(gated.map((r) => r.tool_name)).toEqual(['finances.updateBudget']);
    expect(ledger.calls.find((c) => c.table === 'ai_plans' && c.kind === 'insert')!.payload).toMatchObject({ requires_approval: true, estimated_actions: 4 });
    const planned = ledger.calls.find((c) => c.table === 'ai_run_events' && c.kind === 'insert')!.payload as { payload: Row };
    expect(planned.payload).toMatchObject({ template: INTENT, agent: 'chief_of_staff', approval_steps: 1, step_count: 9 });
    // Nothing was written that only execution may write.
    expect([...ledger.calls, ...trust.calls].filter((c) => c.kind !== 'select').map((c) => c.table)).not.toContain('approval_requests');

    // ── Executed: all four reads in one wave, safe work done, one gate ──
    const h = harnessFor(snapshotsFrom(rows), String(rows[0].plan_id));
    const readIds = reads.map((r) => String(r.id)).sort();
    const idOf = (tool: string) => String(rows.find((r) => r.tool_name === tool)!.id);

    const parked = await runGraphWith(h.port, 'run-1', { budgetMs: 60_000 });

    expect(parked.status).toBe('awaiting_approval');
    expect(h.calls.slice(0, 4).sort()).toEqual(readIds);
    expect(h.peak).toBe(Math.min(4, MAX_STEP_CONCURRENCY));
    for (const id of readIds) expect(h.step(id).status).toBe('completed');
    for (const tool of ['calendar.createEvent', 'tasks.createTodo', 'groceries.addItems']) expect(h.step(idOf(tool)).status, tool).toBe('completed');
    expect(h.step(idOf('finances.updateBudget')).status).toBe('awaiting_approval');
    expect(Object.keys(h.approvals)).toHaveLength(1);
    expect(h.events.filter((e) => e.eventType === 'approval_requested')).toHaveLength(1);
    const tell = h.steps.find((s) => s.step_type === 'notify')!;
    expect(tell.status).toBe('queued');
    expect(h.run.state).toBe('awaiting_approval');

    // ── Approved: the gated step runs, the asker is told, the run completes ──
    h.approvals[`appr-${idOf('finances.updateBudget')}`].status = 'approved';
    h.run.state = 'ready';
    const finished = await runGraphWith(h.port, 'run-1', { budgetMs: 60_000 });

    expect(finished).toMatchObject({ status: 'completed', completed: 9, failed: 0 });
    expect(h.step(idOf('finances.updateBudget')).status).toBe('completed');
    expect(h.step(tell.id).status).toBe('completed');
    expect(h.events.map((e) => e.eventType)).toContain('notified');
    expect(h.calls).toHaveLength(8);
  });
});
