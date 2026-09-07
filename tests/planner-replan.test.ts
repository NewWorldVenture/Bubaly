// `replanRun` is the planner half of a `replan` step: the executor hands it
// the run and every step of the current plan, and it must come back with a
// NEW plan version that carries what already happened and adds only what is
// left. Proven here against a fake ledger and a scripted model: version N+1
// is written and N superseded; settled steps keep their status, result and
// error; the replan step itself is carried as completed (the executor counts
// those against `MAX_REPLANS_PER_RUN`); a step that never ran is replaced;
// and the model is told what happened — what failed and what a person
// declined included — before it plans the rest.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { AIProvider } from '@/lib/ai/provider';
import type { Plan, PlanStep } from '@/lib/ai/planner/schema';
import type { RunSnapshot, StepSnapshot } from '@/lib/ai/runs/executor';
import type { ServiceScope } from '@/lib/services/types';

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => { throw new Error('the test passes its own ledger'); } }));
// The context builder is a separate concern with its own tests; a re-plan only
// needs it to answer.
vi.mock('@/lib/ai/context/builder', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai/context/builder')>();
  return {
    ...actual,
    buildContext: async () => ({
      ok: true,
      data: {
        header: { familyName: 'The Riveras', tz: 'America/New_York', locale: 'en-US', currency: 'USD', nowIso: '2026-09-05T16:00:00.000Z', todayKey: '2026-09-05', viewerRole: 'parent', viewerName: 'Dana' },
        slices: { people: { members: [{ id: 'mem-parent', name: 'Dana', role: 'parent', canManage: true }] } },
        stats: { people_count: 1 },
        sensitiveOmitted: [],
        text: 'Family: The Riveras\nSoccer practice Wednesday 4pm.',
      },
    }),
  };
});

const { replanRun } = await import('@/lib/ai/planner/index');
const { replanPortFor } = await import('@/lib/ai/planner/replan-port');

const NOW = new Date('2026-09-05T16:00:00Z');

// The fail-closed case below logs the missing model on purpose; keep the run quiet.
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

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

function step(partial: Partial<PlanStep> & { key: string }): PlanStep {
  return {
    step_type: 'retrieve', tool_name: null, description: partial.key, input: '{}', depends_on: [], condition: null, approval_required: null, verify: null,
    ...partial,
  };
}

function freshPlan(): Plan {
  return {
    objective: 'Finish the week', reasoning_summary: 'The dentist still needs calling.', risk_level: 'low', followups: [], clarification: null, answer: null,
    steps: [
      step({ key: 'todos', tool_name: 'tasks.searchTodos', input: '{"done":false,"limit":50}' }),
      step({ key: 'add', step_type: 'act', tool_name: 'tasks.createTodo', description: 'Add the dentist call', input: '{"title":"Call the dentist"}', depends_on: ['todos'] }),
      step({ key: 'tell', step_type: 'notify', input: '{"recipients":"managers","type":"system","title":"Done","body":"Dentist call on the list."}', depends_on: ['add'] }),
    ],
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

function snapshot(partial: Partial<StepSnapshot> & { id: string }, index: number): StepSnapshot {
  return {
    plan_id: 'plan-1', sequence: index, step_type: 'act', tool_name: null, description: partial.id, input_json: {}, dependency_ids: [], condition: null,
    status: 'queued', approval_required: false, approval_id: null, risk_level: 'low', retry_count: 0, max_retries: 2, result_json: null, error: null,
    ...partial,
  };
}

const RUN: RunSnapshot = {
  id: 'run-1', family_id: 'fam-1', plan_id: 'plan-1', request_id: 'req-1', state: 'executing', cancel_requested_at: null, paused_at: null,
  requested_by_member_id: 'mem-parent', attempt: 1, max_attempts: 5, lease_owner: 'lease-1',
};

/** Plan version 1 at the moment the replan step runs: everything else settled or doomed. */
const STEPS: StepSnapshot[] = ([
  { id: 's-read', step_type: 'retrieve', tool_name: 'calendar.searchEvents', description: 'Read the week', status: 'completed', result_json: { summary: '3 events' } },
  { id: 's-act', step_type: 'act', tool_name: 'tasks.createTodo', description: 'Add the form', input_json: { title: 'Sign the form' }, dependency_ids: ['s-read'], status: 'completed', result_json: { summary: 'Added' } },
  { id: 's-fail', step_type: 'act', tool_name: 'calendar.createEvent', description: 'Book the dentist', input_json: { title: 'Dentist', starts_at: '2026-09-08T09:00:00' }, dependency_ids: ['s-read'], status: 'failed', error: 'The calendar service timed out.' },
  { id: 's-declined', step_type: 'act', tool_name: 'finances.updateBudget', description: 'Tighten the grocery budget', input_json: { category: 'Groceries', amount: 600 }, status: 'cancelled', approval_required: true, approval_id: 'appr-1', error: 'The request was rejected.' },
  { id: 's-blocked', step_type: 'notify', description: 'Tell Dana the dentist is booked', input_json: { recipients: 'managers', type: 'system', title: 'Booked' }, dependency_ids: ['s-fail'], status: 'blocked', error: 'A step this one depends on did not finish.' },
  { id: 's-replan', step_type: 'replan', description: 'Decide the rest', input_json: { prompt: 'Decide what else the week needs' }, dependency_ids: ['s-read'], status: 'executing' },
] as Array<Partial<StepSnapshot> & { id: string }>).map(snapshot);

function scopeWith(db: SupabaseClient<Database>): ServiceScope {
  return { db, familyId: 'fam-1', userId: 'auth-1', memberId: 'mem-parent', role: 'parent', actorKind: 'ai', tz: 'America/New_York', now: NOW };
}

const REQUEST: Row = { id: 'req-1', family_id: 'fam-1', request_text: 'Handle everything for this week', interpreted_intent: 'chief_of_staff', prompt_tokens: 0, completion_tokens: 0, latency_ms: 0, clarifications: [] };

describe('replanRun', () => {
  it('writes plan version N+1 that carries what happened, adds only what is left, and tells the model the truth about both', async () => {
    const ledger = makeLedger({ ai_requests: [REQUEST], ai_plans: [{ id: 'plan-1', version: 1 }] });
    const trust = makeLedger();
    const seen = { system: '', user: '' };
    const provider = providerReplying(freshPlan(), seen);

    const result = await replanRun(scopeWith(trust.db), RUN, STEPS[5], STEPS, { provider, db: ledger.db, now: NOW });

    expect(result.ok, result.ok ? '' : result.error).toBe(true);
    if (!result.ok) return;
    expect(result.data.planId).toBe('ai_plans-1');

    // ── The prompt: the intent's own catalogue, and an honest account so far ──
    expect(seen.system).toMatch(/^Intent: chief_of_staff$/m);
    expect(seen.user).toContain('What has happened so far:');
    expect(seen.user).toContain('- Read the week: 3 events');
    expect(seen.user).toContain('- Add the form: Added');
    expect(seen.user).toContain('- Book the dentist: FAILED (The calendar service timed out.)');
    expect(seen.user).toContain('- Tighten the grocery budget: DECLINED by a person (The request was rejected.); do not plan it again');
    expect(seen.user).not.toContain('Tell Dana the dentist is booked');
    expect(seen.user).toContain('Now: Decide what else the week needs');
    expect(seen.user).toMatch(/Plan ONLY the remaining work/);

    // ── The ledger: version 2, version 1 superseded, under the same request ──
    const planInsert = ledger.calls.find((c) => c.table === 'ai_plans' && c.kind === 'insert')!;
    expect(planInsert.payload).toMatchObject({ family_id: 'fam-1', request_id: 'req-1', version: 2, objective: 'Finish the week', status: 'approved' });
    const superseded = ledger.calls.find((c) => c.table === 'ai_plans' && c.kind === 'update')!;
    expect(superseded.payload).toEqual({ status: 'superseded' });
    expect(superseded.filters).toMatchObject({ 'eq:family_id': 'fam-1', 'eq:request_id': 'req-1' });

    // ── The steps: settled ones carried with their outcome, the replan step
    //    carried as completed, the blocked one replaced, the fresh ones queued ──
    const rows = ledger.calls.find((c) => c.table === 'ai_plan_steps' && c.kind === 'insert')!.payload as Row[];
    expect(rows).toHaveLength(8);
    expect(rows.every((r) => r.family_id === 'fam-1' && r.plan_id === 'ai_plans-1')).toBe(true);
    const byTool = (tool: string) => rows.find((r) => r.tool_name === tool)!;
    expect(byTool('calendar.searchEvents')).toMatchObject({ status: 'completed', result_json: { summary: '3 events' }, dependency_ids: [] });
    expect(byTool('calendar.createEvent')).toMatchObject({ status: 'failed', error: 'The calendar service timed out.', dependency_ids: [byTool('calendar.searchEvents').id] });
    expect(byTool('finances.updateBudget')).toMatchObject({ status: 'cancelled', approval_required: true, approval_id: 'appr-1', error: 'The request was rejected.' });
    expect(rows.some((r) => r.status === 'blocked')).toBe(false);
    expect(rows.some((r) => r.description === 'Tell Dana the dentist is booked')).toBe(false);
    const replan = rows.find((r) => r.step_type === 'replan')!;
    expect(replan).toMatchObject({ status: 'completed', result_json: { summary: 'Re-planned the rest of this run.' }, dependency_ids: [byTool('calendar.searchEvents').id], approval_required: false });
    // Carried rows get fresh ids in the new version: nothing collides with plan 1.
    expect(rows.map((r) => r.id)).not.toContain('s-read');
    const fresh = rows.filter((r) => r.status === 'queued');
    expect(fresh.map((r) => r.tool_name)).toEqual(['tasks.searchTodos', 'tasks.createTodo', null]);
    expect(fresh[1].dependency_ids).toEqual([fresh[0].id]);
    expect(fresh[2].dependency_ids).toEqual([fresh[1].id]);
    // Sequence keeps carried work ahead of the decision, and the decision ahead of the fresh work.
    expect(rows.map((r) => r.sequence)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(rows.indexOf(replan)).toBe(4);
  });

  it('is bound to the ledger client by replanPortFor, and fails closed when no planning model is configured', async () => {
    const ledger = makeLedger({ ai_requests: [REQUEST], ai_plans: [{ id: 'plan-1', version: 1 }] });
    const trust = makeLedger();
    const port = replanPortFor(ledger.db);
    // The port has no provider slot: the real one resolves the planning model
    // itself. This checkout has none configured, so the bound port reads the
    // request through the client it was given, gets no plan, and writes
    // nothing — the executor then fails the replan step rather than pretend.
    const result = await port(scopeWith(trust.db), RUN, STEPS[5], STEPS);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('unconfigured');
    expect(ledger.calls.some((c) => c.table === 'ai_requests' && c.kind === 'select' && c.filters['eq:family_id'] === 'fam-1')).toBe(true);
    // The usage meter still records the attempt on the request row; no plan
    // version and no steps were written.
    expect(ledger.calls.filter((c) => c.kind !== 'select').map((c) => c.table)).toEqual(['ai_requests']);
    expect(ledger.calls.some((c) => c.table === 'ai_plans' || c.table === 'ai_plan_steps')).toBe(false);
  });

  it('refuses a run that has no request behind it, and writes nothing', async () => {
    const ledger = makeLedger();
    const result = await replanRun(scopeWith(makeLedger().db), { ...RUN, request_id: null }, STEPS[5], STEPS, { db: ledger.db, now: NOW });
    expect(result.ok).toBe(false);
    expect(ledger.calls).toEqual([]);
  });
});
