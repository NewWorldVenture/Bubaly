// `decide` / `editAndApprove` are the single place an approval becomes work,
// so these tests are about what each payload kind does when a parent says yes
// or no, and what can never happen twice:
//
//   • plan_steps: the gated step goes back to `ready`, the run leaves
//     `awaiting_approval`, the executor is kicked, and NO second approval row
//     is opened;
//   • tool: a `{name,args}` payload executes through `executeTool` with the
//     trust gate skipped — including the legacy alias spelling;
//   • concierge_plan: the write-backs land through the shared materialiser and
//     the legacy pending automation row is closed;
//   • a rejection cancels the gated step and blocks what depended on it;
//   • the second decision on the same row is refused, both when the row is
//     already decided and when two decisions race the conditional update;
//   • every decision writes a `trust_audit_logs` row stamped with the
//     `family_members.id`, never the auth user id.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';

const holder = vi.hoisted(() => ({ service: null as SupabaseClient<Database> | null }));
const kicked = vi.hoisted(() => ({ runs: [] as string[] }));
const executed = vi.hoisted(() => ({ calls: [] as { name: string; args: unknown; opts: Record<string, unknown> }[], outcome: null as unknown }));

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => {
    if (!holder.service) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured');
    return holder.service;
  },
}));
vi.mock('@/lib/ai/runs/continue', () => ({
  kickRun: (runId: string) => { kicked.runs.push(runId); },
  continueRun: async () => ({ status: 'unavailable', completed: 0, failed: 0, pending: 0, awaitingApproval: 0, claimed: false }),
}));
vi.mock('@/lib/ai/tools/execute', () => ({
  executeTool: async (_scope: unknown, name: string, args: unknown, opts: Record<string, unknown>) => {
    executed.calls.push({ name, args, opts });
    return executed.outcome ?? { status: 'ok', data: { id: 'ev-1' }, summary: `Did ${name}`, toolCallId: 'call-1', verified: true };
  },
}));

const { decide, editAndApprove, classifyPayload } = await import('@/lib/services/approvals');

type Call = { table: string; kind: 'select' | 'insert' | 'update' | 'delete'; filters: Record<string, unknown>; payload?: unknown };
type Row = Record<string, unknown> & { id: string };

/**
 * An in-memory PostgREST fake with just enough semantics for the approval
 * flow: `eq`/`in`/`filter` filters are applied to selects and updates against
 * per-table row arrays, so the `status = 'pending'` guard on the decision
 * update behaves like the real one (zero rows when it no longer matches).
 */
function makeStore(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = Object.fromEntries(Object.entries(seed).map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
  const calls: Call[] = [];
  let counter = 0;

  const matches = (row: Row, filters: Record<string, unknown>) =>
    Object.entries(filters).every(([key, value]) => {
      if (key.startsWith('in:')) return (value as unknown[]).includes(row[key.slice(3)]);
      if (key.startsWith('json:')) {
        const [col, path] = key.slice(5).split('->>');
        const obj = row[col] as Record<string, unknown> | null;
        return obj?.[path] === value;
      }
      if (key.startsWith('lt:') || key.startsWith('gt:') || key.startsWith('or:')) return true;
      return row[key] === value;
    });

  const from = (table: string) => {
    const call: Call = { table, kind: 'select', filters: {} };
    calls.push(call);
    const b: Record<string, unknown> = {};
    const chain = () => b;
    const filter = (column: string, value: unknown) => { call.filters[column] = value; return b; };
    const resolve = (): { data: unknown; error: null } => {
      const rows = tables[table] ?? (tables[table] = []);
      if (call.kind === 'insert') {
        const payloads = Array.isArray(call.payload) ? call.payload : [call.payload];
        const inserted = (payloads as Row[]).map((p) => ({ ...p, id: p.id ?? `${table}-${++counter}` }));
        rows.push(...inserted);
        return { data: inserted.length === 1 ? inserted[0] : inserted, error: null };
      }
      if (call.kind === 'update') {
        const hit = rows.filter((r) => matches(r, call.filters));
        for (const r of hit) Object.assign(r, call.payload as Record<string, unknown>);
        return { data: hit, error: null };
      }
      return { data: rows.filter((r) => matches(r, call.filters)), error: null };
    };
    Object.assign(b, {
      select: chain, order: chain, limit: chain, or: (expr: string) => filter(`or:${expr}`, true),
      eq: filter, is: filter,
      in: (c: string, v: unknown) => filter(`in:${c}`, v),
      lt: (c: string, v: unknown) => filter(`lt:${c}`, v),
      gt: (c: string, v: unknown) => filter(`gt:${c}`, v),
      filter: (c: string, _op: string, v: unknown) => filter(`json:${c}`, v),
      insert: (payload: unknown) => { call.kind = 'insert'; call.payload = payload; return b; },
      update: (payload: unknown) => { call.kind = 'update'; call.payload = payload; return b; },
      delete: () => { call.kind = 'delete'; return b; },
      single: () => { const r = resolve(); return Promise.resolve({ data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: null }); },
      maybeSingle: () => { const r = resolve(); return Promise.resolve({ data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: null }); },
      then: (onFulfilled: (value: { data: unknown; error: null }) => void) => onFulfilled(resolve()),
    });
    return b;
  };
  return { db: { from } as unknown as SupabaseClient<Database>, calls, tables };
}

const NOW = new Date('2026-09-05T12:00:00Z');

function scopeWith(db: SupabaseClient<Database>, extra?: Partial<ServiceScope>): ServiceScope {
  return {
    db, familyId: 'fam-1', userId: 'auth-user-1', memberId: 'member-1', role: 'parent', actorKind: 'member',
    tz: 'America/New_York', now: NOW, ...extra,
  };
}

function approvalRow(over: Partial<Row> = {}): Row {
  return {
    id: 'appr-1', family_id: 'fam-1', domain: 'calendar', capability: 'automate', requested_by_kind: 'ai',
    requested_by_member_id: null, agent: 'concierge', title: 'Add soccer Saturday', summary: null,
    payload: {}, amount_cents: null, confidence: 0.9, policy_id: null, reasoning: 'risk tier', approval_model: 'single',
    required_approvals: 1, approvals: [], status: 'pending', priority: 'normal', decided_by: null, decided_at: null,
    expires_at: '2026-09-07T12:00:00Z', executed_at: null, execution_result: null, request_id: 'req-1', run_id: null,
    plan_step_id: null, plan_step_ids: [], consequences: ['Adds soccer at 9:00 AM Saturday'], evidence: null,
    edited_payload: null, payload_kind: null, reviewed_by: null, review_note: null,
    created_at: '2026-09-05T10:00:00Z', updated_at: '2026-09-05T10:00:00Z',
    ...over,
  };
}

function runRow(over: Partial<Row> = {}): Row {
  return {
    id: 'run-1', family_id: 'fam-1', plan_id: 'plan-1', request_id: 'req-1', requested_by_member_id: 'member-1',
    state: 'awaiting_approval', status: 'pending', run_type: 'concierge', attempt: 1, max_attempts: 5,
    lease_owner: null, lease_expires_at: null, paused_at: null, cancel_requested_at: null, error: null,
    created_at: '2026-09-05T10:00:00Z', ...over,
  };
}

function stepRow(over: Partial<Row> = {}): Row {
  return {
    id: 'step-1', family_id: 'fam-1', plan_id: 'plan-1', sequence: 1, step_type: 'act', tool_name: 'calendar.createEvent',
    description: 'Add soccer', input_json: { title: 'Soccer', starts_at: '2026-09-06T13:00:00Z' }, dependency_ids: [],
    condition: null, status: 'awaiting_approval', approval_required: true, approval_id: 'appr-1', risk_level: 'medium',
    retry_count: 0, max_retries: 2, result_json: null, error: null, started_at: null, completed_at: null, ...over,
  };
}

beforeEach(() => {
  holder.service = null;
  kicked.runs = [];
  executed.calls = [];
  executed.outcome = null;
});

describe('classifyPayload', () => {
  it('reads the three declared kinds and recognises the two legacy shapes', () => {
    expect(classifyPayload({ payload: { name: 'create_calendar_event', args: { title: 'x' } }, payload_kind: 'tool', run_id: null, plan_step_ids: [], plan_step_id: null }))
      .toEqual({ kind: 'tool', name: 'create_calendar_event', args: { title: 'x' } });
    expect(classifyPayload({ payload: { kind: 'plan_steps', run_id: 'run-1', step_ids: ['s1'] }, payload_kind: 'plan_steps', run_id: null, plan_step_ids: ['s2'], plan_step_id: null }))
      .toMatchObject({ kind: 'plan_steps', runId: 'run-1', stepIds: ['s1', 's2'] });
    // Pre-0251 rows: the trust bridge's {name,args} and the concierge loop's {plan_id,kinds}.
    expect(classifyPayload({ payload: { name: 'add_todo', args: {} }, payload_kind: null, run_id: null, plan_step_ids: [], plan_step_id: null })?.kind).toBe('tool');
    expect(classifyPayload({ payload: { plan_id: 'plan-9', kinds: ['calendar', 'bogus'] }, payload_kind: null, run_id: null, plan_step_ids: [], plan_step_id: null }))
      .toEqual({ kind: 'concierge_plan', planId: 'plan-9', kinds: ['calendar'] });
    expect(classifyPayload({ payload: { mystery: true }, payload_kind: null, run_id: null, plan_step_ids: [], plan_step_id: null })).toBeNull();
  });
});

describe('decide — plan_steps', () => {
  it('approves: step → ready, run → ready and kicked, audit stamped with the member id, no second approval row', async () => {
    const store = makeStore({
      approval_requests: [approvalRow({
        payload: { kind: 'plan_steps', run_id: 'run-1', step_ids: ['step-1'] }, payload_kind: 'plan_steps',
        run_id: 'run-1', plan_step_ids: ['step-1'], plan_step_id: 'step-1',
      })],
      family_automation_runs: [runRow()],
      ai_plan_steps: [stepRow()],
      ai_requests: [{ id: 'req-1', family_id: 'fam-1', status: 'awaiting_approval' }],
    });
    holder.service = store.db;

    const res = await decide(scopeWith(store.db), 'appr-1', 'approved');
    expect(res).toMatchObject({ ok: true, data: { status: 'approved', executed: true, resumedRunId: 'run-1' } });

    const approval = store.tables.approval_requests[0];
    expect(approval.status).toBe('approved');
    // 0093: decided_by references family_members(id), not auth.users.
    expect(approval.decided_by).toBe('member-1');
    expect(approval.executed_at).toBeTruthy();

    expect(store.tables.ai_plan_steps[0]).toMatchObject({ status: 'ready', approval_required: true, approval_id: 'appr-1' });
    expect(store.tables.family_automation_runs[0]).toMatchObject({ state: 'ready', status: 'approved', error: null });
    expect(kicked.runs).toEqual(['run-1']);

    // Exactly one approval row still exists — nothing re-opened a gate.
    expect(store.tables.approval_requests).toHaveLength(1);
    expect(store.calls.filter((c) => c.table === 'approval_requests' && c.kind === 'insert')).toHaveLength(0);

    const audits = store.tables.trust_audit_logs;
    expect(audits.map((a) => a.decision)).toEqual(['approved', 'approved_execution']);
    expect(audits.every((a) => a.actor_id === 'member-1' && a.family_id === 'fam-1' && a.approval_id === 'appr-1')).toBe(true);

    const event = store.tables.ai_run_events.find((e) => e.event_type === 'approval_decided');
    expect(event).toMatchObject({ run_id: 'run-1', family_id: 'fam-1', step_id: 'step-1', actor_kind: 'member' });
    // The executor does the tool call under the run's key; decide() never calls it directly here.
    expect(executed.calls).toHaveLength(0);
  });

  it('rejects: the gated step is cancelled, its dependents blocked, the run resumes so it can finish honestly', async () => {
    const store = makeStore({
      approval_requests: [approvalRow({ payload: { kind: 'plan_steps', run_id: 'run-1', step_ids: ['step-1'] }, payload_kind: 'plan_steps', run_id: 'run-1', plan_step_ids: ['step-1'] })],
      family_automation_runs: [runRow()],
      ai_plan_steps: [
        stepRow(),
        stepRow({ id: 'step-2', sequence: 2, status: 'queued', approval_required: false, approval_id: null, dependency_ids: ['step-1'], description: 'Remind Emma' }),
        stepRow({ id: 'step-3', sequence: 3, status: 'completed', approval_required: false, approval_id: null, dependency_ids: [], description: 'Already done' }),
      ],
      ai_requests: [{ id: 'req-1', family_id: 'fam-1', status: 'awaiting_approval' }],
    });
    holder.service = store.db;

    const res = await decide(scopeWith(store.db), 'appr-1', 'rejected', 'Not this weekend');
    expect(res).toMatchObject({ ok: true, data: { status: 'rejected', executed: false } });

    const [gated, dependent, done] = store.tables.ai_plan_steps;
    expect(gated.status).toBe('cancelled');
    expect(dependent.status).toBe('blocked');
    expect(done.status).toBe('completed');
    expect(store.tables.approval_requests[0]).toMatchObject({ status: 'rejected', review_note: 'Not this weekend', decided_by: 'member-1' });
    // Returned to the queue so the executor computes partially_completed/failed rather than hanging.
    expect(store.tables.family_automation_runs[0].state).toBe('ready');
    expect(kicked.runs).toEqual(['run-1']);
    expect(store.tables.trust_audit_logs.map((a) => a.decision)).toEqual(['rejected']);
  });

  it('leaves a paused run paused: the step is released but nobody overrides the person who paused it', async () => {
    const store = makeStore({
      approval_requests: [approvalRow({ payload: { kind: 'plan_steps', run_id: 'run-1', step_ids: ['step-1'] }, payload_kind: 'plan_steps', run_id: 'run-1', plan_step_ids: ['step-1'] })],
      family_automation_runs: [runRow({ state: 'paused', paused_at: NOW.toISOString() })],
      ai_plan_steps: [stepRow()],
    });
    holder.service = store.db;
    const res = await decide(scopeWith(store.db), 'appr-1', 'approved');
    expect(res).toMatchObject({ ok: true, data: { resumedRunId: null } });
    expect(store.tables.ai_plan_steps[0].status).toBe('ready');
    expect(store.tables.family_automation_runs[0].state).toBe('paused');
    expect(kicked.runs).toEqual([]);
  });
});

describe('decide — tool payloads', () => {
  it('executes a legacy alias payload through executeTool with the gate skipped and a stable idempotency key', async () => {
    const store = makeStore({
      approval_requests: [approvalRow({ payload: { name: 'create_calendar_event', args: { title: 'Soccer', starts_at: '2026-09-06T13:00:00Z' } } })],
    });
    holder.service = store.db;

    const res = await decide(scopeWith(store.db), 'appr-1', 'approved');
    expect(res).toMatchObject({ ok: true, data: { status: 'approved', executed: true, resumedRunId: null, summary: 'Did create_calendar_event' } });

    expect(executed.calls).toHaveLength(1);
    const [call] = executed.calls;
    expect(call.name).toBe('create_calendar_event');
    expect(call.args).toEqual({ title: 'Soccer', starts_at: '2026-09-06T13:00:00Z' });
    expect(call.opts.skipTrust).toBe(true);
    expect(typeof call.opts.idempotencyKey).toBe('string');

    expect(store.tables.approval_requests[0]).toMatchObject({ status: 'approved', execution_result: 'Did create_calendar_event' });
    expect(store.tables.trust_audit_logs.map((a) => a.decision)).toEqual(['approved', 'approved_execution']);
  });

  it('hands a gate-opened tool approval back to its run step instead of executing it twice', async () => {
    // The tool gate inside a run opened this row: {name,args}, no run_id, but a
    // step carries approval_id = appr-1. The step must run it, not decide().
    const store = makeStore({
      approval_requests: [approvalRow({ payload: { name: 'calendar.createEvent', args: { title: 'Soccer' } }, payload_kind: 'tool' })],
      family_automation_runs: [runRow()],
      ai_plan_steps: [stepRow({ approval_required: false })],
      ai_requests: [{ id: 'req-1', family_id: 'fam-1', status: 'awaiting_approval' }],
    });
    holder.service = store.db;

    const res = await decide(scopeWith(store.db), 'appr-1', 'approved');
    expect(res).toMatchObject({ ok: true, data: { executed: true, resumedRunId: 'run-1' } });
    expect(executed.calls).toHaveLength(0);
    expect(store.tables.ai_plan_steps[0]).toMatchObject({ status: 'ready', approval_required: true });
    expect(kicked.runs).toEqual(['run-1']);
  });

  it('reports an execution failure honestly and stamps it, while the decision itself stands', async () => {
    executed.outcome = { status: 'error', error: 'Calendar is read-only right now.', retryable: true, toolCallId: null };
    const store = makeStore({ approval_requests: [approvalRow({ payload: { name: 'create_calendar_event', args: { title: 'Soccer' } } })] });
    holder.service = store.db;

    const res = await decide(scopeWith(store.db), 'appr-1', 'approved');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('Calendar is read-only');
    expect(store.tables.approval_requests[0]).toMatchObject({ status: 'approved', execution_result: 'error: Calendar is read-only right now.' });
  });
});

describe('decide — concierge_plan', () => {
  it('materialises the write-backs once and closes the legacy pending automation row', async () => {
    const store = makeStore({
      approval_requests: [approvalRow({ payload: { plan_id: 'plan-9', kinds: ['calendar', 'reminder', 'task'] }, domain: 'scheduling', title: 'Execute plan: Zoo trip' })],
      concierge_plans: [{ id: 'plan-9', family_id: 'fam-1', title: 'Zoo trip', description: 'Take the kids', location: 'City Zoo', planned_for: '2026-09-12', budget_cents: 5000 }],
      concierge_plan_actions: [{ id: 'cpa-1', family_id: 'fam-1', plan_id: 'plan-9', action_kind: 'reminder' }],
      family_automation_runs: [{ id: 'legacy-run', family_id: 'fam-1', status: 'pending', metadata: { plan_id: 'plan-9', approval_id: 'appr-1' } }],
    });
    holder.service = store.db;

    const res = await decide(scopeWith(store.db), 'appr-1', 'approved');
    expect(res).toMatchObject({ ok: true, data: { status: 'approved', executed: true } });
    if (res.ok) expect(res.data.summary).toContain('Zoo trip');

    // The reminder already existed in the ledger, so only calendar + task land.
    expect(store.tables.calendar_events).toHaveLength(1);
    expect(store.tables.calendar_events[0]).toMatchObject({ family_id: 'fam-1', created_by: 'auth-user-1', title: 'Zoo trip', all_day: true });
    expect(store.tables.family_reminders).toHaveLength(1);
    expect(store.tables.family_reminders[0]).toMatchObject({ kind: 'task', title: 'Prep: Zoo trip', ai_suggested: true });
    expect(store.tables.concierge_plan_actions.map((a) => a.action_kind).sort()).toEqual(['calendar', 'reminder', 'task']);

    expect(store.tables.family_automation_runs[0]).toMatchObject({ status: 'executed', approved_by: 'auth-user-1' });
    expect(store.tables.approval_requests[0].status).toBe('approved');
  });

  it('dismisses the legacy row on rejection without touching the plan', async () => {
    const store = makeStore({
      approval_requests: [approvalRow({ payload: { plan_id: 'plan-9', kinds: ['calendar'] } })],
      family_automation_runs: [{ id: 'legacy-run', family_id: 'fam-1', status: 'pending', metadata: { approval_id: 'appr-1' } }],
    });
    holder.service = store.db;
    const res = await decide(scopeWith(store.db), 'appr-1', 'rejected');
    expect(res).toMatchObject({ ok: true, data: { status: 'rejected' } });
    expect(store.tables.family_automation_runs[0].status).toBe('dismissed');
    expect(store.tables.calendar_events ?? []).toHaveLength(0);
  });
});

describe('decide — guards', () => {
  it('refuses a second decision on a decided row', async () => {
    const store = makeStore({ approval_requests: [approvalRow({ status: 'approved', payload: { name: 'add_todo', args: {} } })] });
    holder.service = store.db;
    const res = await decide(scopeWith(store.db), 'appr-1', 'approved');
    expect(res).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(executed.calls).toHaveLength(0);
  });

  it('refuses the loser of a race: the conditional update touched zero rows', async () => {
    const store = makeStore({ approval_requests: [approvalRow({ payload: { name: 'add_todo', args: {} } })] });
    holder.service = store.db;
    // Someone else flips the row between our read and our update.
    const fake = store.db as unknown as { from: (table: string) => unknown };
    const original = fake.from;
    let reads = 0;
    fake.from = (table: string) => {
      if (table === 'approval_requests') {
        reads += 1;
        if (reads === 2) store.tables.approval_requests[0].status = 'rejected';
      }
      return original(table);
    };
    const res = await decide(scopeWith(store.db), 'appr-1', 'approved');
    expect(res).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(executed.calls).toHaveLength(0);
    expect(store.tables.trust_audit_logs ?? []).toHaveLength(0);
  });

  it('refuses non-managers before reading anything, and cross-family ids read as not found', async () => {
    const store = makeStore({ approval_requests: [approvalRow({ family_id: 'fam-2' })] });
    holder.service = store.db;
    const teen = await decide(scopeWith(store.db, { role: 'teen' }), 'appr-1', 'approved');
    expect(teen).toMatchObject({ ok: false, code: 'denied' });
    expect(store.calls).toHaveLength(0);

    const other = await decide(scopeWith(store.db), 'appr-1', 'approved');
    expect(other).toMatchObject({ ok: false, code: 'not_found' });
    expect(store.calls[0].filters.family_id).toBe('fam-1');
  });

  it('refuses an expired row and a repeat vote from the same member', async () => {
    const store = makeStore({ approval_requests: [approvalRow({ expires_at: '2026-09-01T00:00:00Z' })] });
    holder.service = store.db;
    expect(await decide(scopeWith(store.db), 'appr-1', 'approved')).toMatchObject({ ok: false, code: 'invalid_input' });

    const voted = makeStore({ approval_requests: [approvalRow({ required_approvals: 2, approvals: [{ member_id: 'member-1', decision: 'approved', note: null, at: 'x' }] })] });
    holder.service = voted.db;
    const res = await decide(scopeWith(voted.db), 'appr-1', 'approved');
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.error).toContain('already responded');
  });

  it('collects votes on a two-parent approval and executes only on the deciding one', async () => {
    const store = makeStore({ approval_requests: [approvalRow({ required_approvals: 2, payload: { name: 'add_todo', args: { task: 'Pack' } } })] });
    holder.service = store.db;

    const first = await decide(scopeWith(store.db), 'appr-1', 'approved');
    expect(first).toMatchObject({ ok: true, data: { status: 'pending', executed: false } });
    expect(store.tables.approval_requests[0].status).toBe('pending');
    expect(executed.calls).toHaveLength(0);

    const second = await decide(scopeWith(store.db, { memberId: 'member-2', userId: 'auth-user-2' }), 'appr-1', 'approved');
    expect(second).toMatchObject({ ok: true, data: { status: 'approved', executed: true } });
    expect(store.tables.approval_requests[0]).toMatchObject({ status: 'approved', decided_by: 'member-2' });
    expect(executed.calls).toHaveLength(1);
  });
});

describe('editAndApprove', () => {
  it('merges edits over the stored args, validates against the tool schema, stores edited_payload, executes the edited version', async () => {
    const store = makeStore({
      approval_requests: [approvalRow({ payload: { name: 'create_calendar_event', args: { title: 'Soccer', starts_at: '2026-09-06T13:00:00Z' } }, payload_kind: 'tool' })],
    });
    holder.service = store.db;

    const res = await editAndApprove(scopeWith(store.db), 'appr-1', { title: 'Soccer practice', name: 'smuggled' });
    expect(res).toMatchObject({ ok: true, data: { status: 'modified', resumedRunId: null } });

    const row = store.tables.approval_requests[0];
    expect(row.status).toBe('modified');
    expect(row.edited_payload).toEqual({ title: 'Soccer practice', starts_at: '2026-09-06T13:00:00Z' });
    expect(row.decided_by).toBe('member-1');
    expect(executed.calls[0].args).toEqual({ title: 'Soccer practice', starts_at: '2026-09-06T13:00:00Z' });
    expect(store.tables.trust_audit_logs.map((a) => a.decision)).toEqual(['modified', 'approved_execution']);
  });

  it('rejects edits the tool schema cannot accept before anything is written', async () => {
    const store = makeStore({
      approval_requests: [approvalRow({ payload: { name: 'create_calendar_event', args: { title: 'Soccer', starts_at: '2026-09-06T13:00:00Z' } } })],
    });
    holder.service = store.db;
    // `title` is a string in the schema; a number edit is the kind of slip a form can produce.
    const res = await editAndApprove(scopeWith(store.db), 'appr-1', { title: 123 });
    expect(res).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(store.tables.approval_requests[0].status).toBe('pending');
    expect(executed.calls).toHaveLength(0);
  });

  it('for a plan step, stores the edited input as edited_payload and releases the step (the executor reads it as the replacement input)', async () => {
    const store = makeStore({
      approval_requests: [approvalRow({
        payload: { kind: 'plan_steps', run_id: 'run-1', step_ids: ['step-1'], input: { title: 'Soccer', starts_at: '2026-09-06T13:00:00Z' } },
        payload_kind: 'plan_steps', run_id: 'run-1', plan_step_ids: ['step-1'],
      })],
      family_automation_runs: [runRow()],
      ai_plan_steps: [stepRow()],
    });
    holder.service = store.db;
    const res = await editAndApprove(scopeWith(store.db), 'appr-1', { starts_at: '2026-09-06T14:00:00Z' });
    expect(res).toMatchObject({ ok: true, data: { status: 'modified', resumedRunId: 'run-1' } });
    expect(store.tables.approval_requests[0].edited_payload).toEqual({ title: 'Soccer', starts_at: '2026-09-06T14:00:00Z' });
    expect(store.tables.ai_plan_steps[0].status).toBe('ready');
    expect(kicked.runs).toEqual(['run-1']);
  });
});
