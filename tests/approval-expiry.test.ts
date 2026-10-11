// The expiry sweep (`expireStale`) is what stops a run from waiting forever
// on an approval nobody answered. It must: flip only PENDING rows past their
// deadline, do so per family with an explicit family_id on every write, block
// the steps and the run that were parked on the approval (with a timeline
// event a person can read), leave runs that are not awaiting approval alone,
// and degrade to zeros — never throw — when the read fails.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';

const holder = vi.hoisted(() => ({ service: null as SupabaseClient<Database> | null }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => holder.service }));
const kicked = vi.hoisted(() => ({ runs: [] as string[] }));
vi.mock('@/lib/ai/runs/continue', () => ({ kickRun: (id: string) => { kicked.runs.push(id); }, continueRun: async () => ({ claimed: false }) }));
vi.mock('@/lib/ai/tools/execute', () => ({ executeTool: async () => ({ status: 'denied', reason: 'not in this test', toolCallId: null }) }));

const { expireStale, resumeSettledRuns } = await import('@/lib/services/approvals');

type Call = { table: string; kind: 'select' | 'insert' | 'update'; filters: Record<string, unknown>; payload?: unknown };
type Row = Record<string, unknown> & { id: string };

function makeStore(seed: Record<string, Row[]>, opts: { failRead?: boolean; failRunUpdate?: boolean; failStepRead?: boolean } = {}) {
  const tables: Record<string, Row[]> = Object.fromEntries(Object.entries(seed).map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
  const calls: Call[] = [];
  let counter = 0;
  const matches = (row: Row, filters: Record<string, unknown>) =>
    Object.entries(filters).every(([key, value]) => {
      if (key.startsWith('in:')) return (value as unknown[]).includes(row[key.slice(3)]);
      if (key.startsWith('lt:')) { const col = key.slice(3); return typeof row[col] === 'string' && (row[col] as string) < (value as string); }
      if (key.startsWith('gt:') || key.startsWith('or:')) return true;
      return row[key] === value;
    });
  const from = (table: string) => {
    const call: Call = { table, kind: 'select', filters: {} };
    calls.push(call);
    const b: Record<string, unknown> = {};
    const chain = () => b;
    const filter = (column: string, value: unknown) => { call.filters[column] = value; return b; };
    const resolve = () => {
      if (opts.failRead && call.kind === 'select' && table === 'approval_requests') {
        return { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } };
      }
      if (opts.failRunUpdate && call.kind === 'update' && table === 'family_automation_runs') {
        return { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } };
      }
      if (opts.failStepRead && call.kind === 'select' && table === 'ai_plan_steps') {
        return { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } };
      }
      const rows = tables[table] ?? (tables[table] = []);
      if (call.kind === 'insert') {
        const payloads = (Array.isArray(call.payload) ? call.payload : [call.payload]) as Row[];
        const inserted = payloads.map((p) => ({ ...p, id: p.id ?? `${table}-${++counter}` }));
        rows.push(...inserted);
        return { data: inserted, error: null };
      }
      if (call.kind === 'update') {
        const hit = rows.filter((r) => matches(r, call.filters));
        for (const r of hit) Object.assign(r, call.payload as Record<string, unknown>);
        return { data: hit, error: null };
      }
      return { data: rows.filter((r) => matches(r, call.filters)), error: null };
    };
    Object.assign(b, {
      select: chain, order: chain, limit: chain, or: chain,
      eq: filter, is: filter,
      in: (c: string, v: unknown) => filter(`in:${c}`, v),
      lt: (c: string, v: unknown) => filter(`lt:${c}`, v),
      gt: (c: string, v: unknown) => filter(`gt:${c}`, v),
      filter: (c: string, _op: string, v: unknown) => filter(c, v),
      insert: (payload: unknown) => { call.kind = 'insert'; call.payload = payload; return b; },
      update: (payload: unknown) => { call.kind = 'update'; call.payload = payload; return b; },
      single: () => { const r = resolve(); return Promise.resolve({ data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error }); },
      maybeSingle: () => { const r = resolve(); return Promise.resolve({ data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error }); },
      then: (onFulfilled: (value: { data: unknown; error: unknown }) => void) => onFulfilled(resolve()),
    });
    return b;
  };
  return { db: { from } as unknown as SupabaseClient<Database>, calls, tables };
}

const NOW = new Date('2026-09-05T12:00:00Z');

function approval(over: Partial<Row>): Row {
  return {
    id: 'a', family_id: 'fam-1', status: 'pending', title: 'Add soccer', run_id: null, plan_step_id: null, plan_step_ids: [],
    expires_at: '2026-09-05T11:00:00Z', ...over,
  };
}

beforeEach(() => { holder.service = null; kicked.runs = []; });

describe('expireStale', () => {
  it('expires pending rows past their deadline, per family, and blocks the runs parked on them', async () => {
    const store = makeStore({
      approval_requests: [
        approval({ id: 'a1', run_id: 'run-1', plan_step_id: 'step-1', plan_step_ids: ['step-1'] }),
        approval({ id: 'a2', family_id: 'fam-2', title: 'Order pizza' }),
        // Not yet due, and already decided: both untouched.
        approval({ id: 'a3', expires_at: '2026-09-09T00:00:00Z' }),
        approval({ id: 'a4', status: 'approved' }),
      ],
      family_automation_runs: [{ id: 'run-1', family_id: 'fam-1', plan_id: 'plan-1', request_id: 'req-1', state: 'awaiting_approval', status: 'pending' }],
      ai_plan_steps: [{ id: 'step-1', family_id: 'fam-1', plan_id: 'plan-1', status: 'awaiting_approval', approval_id: 'a1', dependency_ids: [] }],
      ai_requests: [{ id: 'req-1', family_id: 'fam-1', status: 'awaiting_approval' }],
    });
    holder.service = store.db;

    const result = await expireStale(store.db, NOW);
    expect(result).toEqual({ expired: 2, blockedRuns: 1, failures: 0 });

    const byId = Object.fromEntries(store.tables.approval_requests.map((r) => [r.id, r.status]));
    expect(byId).toEqual({ a1: 'expired', a2: 'expired', a3: 'pending', a4: 'approved' });

    // Every write carried its family_id and the pending guard.
    const updates = store.calls.filter((c) => c.kind === 'update' && c.table === 'approval_requests');
    expect(updates).toHaveLength(2);
    expect(updates.map((u) => u.filters.family_id).sort()).toEqual(['fam-1', 'fam-2']);
    expect(updates.every((u) => u.filters.status === 'pending')).toBe(true);

    expect(store.tables.ai_plan_steps[0]).toMatchObject({ status: 'blocked' });
    expect(store.tables.family_automation_runs[0]).toMatchObject({ state: 'blocked', status: 'approved' });
    expect(store.tables.family_automation_runs[0].error).toContain('expired');
    expect(store.tables.ai_requests[0].status).toBe('blocked');
    const event = store.tables.ai_run_events[0];
    expect(event).toMatchObject({ family_id: 'fam-1', run_id: 'run-1', event_type: 'blocked', actor_kind: 'system' });
    expect(event.message).toContain('Add soccer');
  });

  it('leaves a run that is not awaiting approval alone (it reconciles the expiry itself on its next pass)', async () => {
    const store = makeStore({
      approval_requests: [approval({ id: 'a1', run_id: 'run-1', plan_step_ids: ['step-1'] })],
      family_automation_runs: [{ id: 'run-1', family_id: 'fam-1', plan_id: 'plan-1', request_id: null, state: 'executing', status: 'approved' }],
      ai_plan_steps: [{ id: 'step-1', family_id: 'fam-1', plan_id: 'plan-1', status: 'awaiting_approval', approval_id: 'a1', dependency_ids: [] }],
    });
    holder.service = store.db;
    const result = await expireStale(store.db, NOW);
    expect(result).toEqual({ expired: 1, blockedRuns: 0, failures: 0 });
    expect(store.tables.family_automation_runs[0].state).toBe('executing');
    expect(store.tables.ai_run_events ?? []).toHaveLength(0);
  });

  it('finds the run through the step when the approval row never recorded a run_id', async () => {
    const store = makeStore({
      approval_requests: [approval({ id: 'a1' })],
      ai_plan_steps: [{ id: 'step-1', family_id: 'fam-1', plan_id: 'plan-1', status: 'awaiting_approval', approval_id: 'a1', dependency_ids: [] }],
      family_automation_runs: [{ id: 'run-1', family_id: 'fam-1', plan_id: 'plan-1', request_id: null, state: 'awaiting_approval', status: 'pending' }],
    });
    holder.service = store.db;
    const result = await expireStale(store.db, NOW);
    expect(result).toEqual({ expired: 1, blockedRuns: 1, failures: 0 });
    expect(store.tables.family_automation_runs[0].state).toBe('blocked');
  });

  it('writes nothing and REPORTS the failure when the sweep read fails', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const store = makeStore({ approval_requests: [approval({ id: 'a1' })] }, { failRead: true });
    holder.service = store.db;
    const result = await expireStale(store.db, NOW);
    // A swallowed read error made the cron answer 200 while nothing expired.
    expect(result).toEqual({ expired: 0, blockedRuns: 0, failures: 1 });
    expect(store.calls.filter((c) => c.kind === 'update')).toHaveLength(0);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });

  it('does nothing when there is nothing due', async () => {
    const store = makeStore({ approval_requests: [approval({ id: 'a1', expires_at: '2026-12-01T00:00:00Z' })] });
    holder.service = store.db;
    expect(await expireStale(store.db, NOW)).toEqual({ expired: 0, blockedRuns: 0, failures: 0 });
    expect(store.calls).toHaveLength(1);
  });

  it('a run that cannot be blocked keeps its approval pending, so the next tick tries again', async () => {
    // Expiring first and blocking after stranded the run: the approval was
    // `expired` (never selected again) and the run stayed `awaiting_approval`
    // (never leased). Now the approval only expires once its run is blocked.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const seed = {
      approval_requests: [approval({ id: 'a1', run_id: 'run-1' })],
      family_automation_runs: [{ id: 'run-1', family_id: 'fam-1', plan_id: 'plan-1', request_id: null, state: 'awaiting_approval', status: 'pending' }],
      ai_plan_steps: [{ id: 'step-1', family_id: 'fam-1', plan_id: 'plan-1', status: 'awaiting_approval', approval_id: 'a1', dependency_ids: [] }],
    };
    const store = makeStore(seed, { failRunUpdate: true });
    holder.service = store.db;
    expect(await expireStale(store.db, NOW)).toEqual({ expired: 0, blockedRuns: 0, failures: 1 });
    expect(store.tables.approval_requests[0].status).toBe('pending');
    errors.mockRestore();
  });

  it('a step read that fails leaves the approval pending and is counted', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const store = makeStore({
      approval_requests: [approval({ id: 'a1', run_id: 'run-1' })],
      family_automation_runs: [{ id: 'run-1', family_id: 'fam-1', plan_id: 'plan-1', request_id: null, state: 'awaiting_approval', status: 'pending' }],
      ai_plan_steps: [{ id: 'step-1', family_id: 'fam-1', plan_id: 'plan-1', status: 'awaiting_approval', approval_id: 'a1', dependency_ids: [] }],
    }, { failStepRead: true });
    holder.service = store.db;
    expect(await expireStale(store.db, NOW)).toMatchObject({ expired: 0, failures: 1 });
    expect(store.tables.approval_requests[0].status).toBe('pending');
    errors.mockRestore();
  });
});

describe('resumeSettledRuns', () => {
  const run = (id: string, over: Partial<Row> = {}): Row => ({
    id, family_id: 'fam-1', plan_id: `plan-${id}`, request_id: null, state: 'awaiting_approval', status: 'pending', ...over,
  });
  const step = (id: string, planId: string, over: Partial<Row>): Row => ({
    id, family_id: 'fam-1', plan_id: planId, status: 'awaiting_approval', approval_id: null, dependency_ids: [], ...over,
  });

  it('returns to the queue a run still parked on an approval that was already decided or expired', async () => {
    // decide() commits the status before folding the run; a fold that failed
    // (or a rejection whose fold was only logged, or an expiry that could not
    // block) left the run at `awaiting_approval`, which nothing leases.
    const store = makeStore({
      approval_requests: [
        approval({ id: 'approved', status: 'approved' }), approval({ id: 'rejected', status: 'rejected' }),
        approval({ id: 'expired', status: 'expired' }), approval({ id: 'pending', status: 'pending' }),
      ],
      family_automation_runs: [
        run('r-approved', { request_id: 'req-1' }), run('r-rejected'), run('r-expired'), run('r-pending'), run('r-partial'),
        run('r-executing', { state: 'executing' }),
      ],
      ai_plan_steps: [
        step('s1', 'plan-r-approved', { approval_id: 'approved' }),
        step('s2', 'plan-r-rejected', { approval_id: 'rejected' }),
        step('s3', 'plan-r-expired', { approval_id: 'expired' }),
        step('s4', 'plan-r-pending', { approval_id: 'pending' }),
        // A partial fold: the step was released but the run update failed.
        step('s5', 'plan-r-partial', { status: 'ready', approval_id: 'approved' }),
      ],
      ai_requests: [{ id: 'req-1', family_id: 'fam-1', status: 'awaiting_approval' }],
    });
    holder.service = store.db;
    const result = await resumeSettledRuns(store.db, NOW);
    expect(result).toEqual({ resumed: 4, failures: 0 });
    const states = Object.fromEntries(store.tables.family_automation_runs.map((r) => [r.id, r.state]));
    expect(states).toEqual({
      'r-approved': 'ready', 'r-rejected': 'ready', 'r-expired': 'ready', 'r-partial': 'ready',
      'r-pending': 'awaiting_approval', 'r-executing': 'executing',
    });
    expect(kicked.runs.sort()).toEqual(['r-approved', 'r-expired', 'r-partial', 'r-rejected']);
    expect(store.tables.ai_requests[0].status).toBe('ready');
    // Only from `awaiting_approval`, so a run someone else moved is not touched.
    const runUpdates = store.calls.filter((c) => c.kind === 'update' && c.table === 'family_automation_runs');
    expect(runUpdates.every((u) => u.filters.state === 'awaiting_approval' && u.filters.family_id === 'fam-1')).toBe(true);
  });

  it('counts a read it could not make instead of reporting a clean sweep', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const store = makeStore({
      family_automation_runs: [run('r1')],
      ai_plan_steps: [step('s1', 'plan-r1', { approval_id: 'a1' })],
    }, { failStepRead: true });
    holder.service = store.db;
    expect(await resumeSettledRuns(store.db, NOW)).toEqual({ resumed: 0, failures: 1 });
    errors.mockRestore();
  });
});
