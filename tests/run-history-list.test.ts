// The run history (M35) and the evidence behind the Handled ledger (M6).
//
// Three promises, each pinned against a real in-memory table rather than a
// scripted fake: the list is FAMILY-SCOPED (another family's runs are absent,
// not forbidden), ORDERED newest first, FILTERED by the §10 state groups the
// page offers — and every read FAILS CLOSED: a read error comes back as a
// retryable failure and is logged, never as an empty list that would look
// like a family Bubaly has never worked for.
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { listRuns } from '@/lib/ai/runs/store';
import { loadRunEvidence } from '@/lib/ai/runs/evidence';
import { loadCompletedByBubaly } from '@/lib/home/completed';
import { RUN_STATES } from '@/lib/ai/runs/states';
import {
  parseRunHistoryCursor, parseRunHistoryFilter, runHistoryItems, RUN_HISTORY_FILTERS, RUN_HISTORY_FILTER_STATES,
  type RunHistoryRunRow,
} from '@/lib/ai/runs/history';
import { scopeForSystem } from '@/lib/services/scope';

type DB = SupabaseClient<Database>;

const FAM = 'fam-1';
const OTHER = 'fam-2';
const NOW = new Date('2026-09-05T14:00:00Z');

function run(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, family_id: FAM, state: 'completed', status: 'executed', summary: `Run ${id}`, progress: {}, result: {}, metadata: {},
    request_id: `req-${id}`, plan_id: null, error: null, completed_at: null,
    created_at: '2026-09-05T10:00:00Z', updated_at: '2026-09-05T10:00:00Z',
    ...over,
  };
}

/** A client whose every read answers `error` — or throws — the way a lost connection does. */
function failingDb(error: unknown, opts: { throws?: boolean } = {}): DB {
  const builder: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in', 'lt', 'gte', 'order', 'limit', 'maybeSingle']) builder[m] = () => builder;
  builder.then = (resolve: (v: unknown) => void) => resolve({ data: null, error, count: null });
  return {
    from: () => {
      if (opts.throws) throw new Error('socket hang up');
      return builder;
    },
  } as unknown as DB;
}

function quietErrors() {
  return vi.spyOn(console, 'error').mockImplementation(() => {});
}

// ─── The read model ─────────────────────────────────────────────────────────

describe('run history filters', () => {
  it('put every §10 run state in exactly one chip, so no run can fall between them', () => {
    const groups = RUN_HISTORY_FILTERS.filter((f) => f !== 'all');
    for (const state of RUN_STATES) {
      const owners = groups.filter((f) => (RUN_HISTORY_FILTER_STATES[f] ?? []).includes(state));
      expect(owners, state).toHaveLength(1);
    }
    expect(RUN_HISTORY_FILTER_STATES.all).toBeNull();
  });

  it('parse an unknown filter as "all" and a bad cursor as nothing, never handing garbage to the query', () => {
    expect(parseRunHistoryFilter('done')).toBe('done');
    expect(parseRunHistoryFilter('bogus')).toBe('all');
    expect(parseRunHistoryFilter(undefined)).toBe('all');
    expect(parseRunHistoryCursor('not a date')).toBeNull();
    expect(parseRunHistoryCursor('')).toBeNull();
    expect(parseRunHistoryCursor('2026-09-05T10:00:00.000Z')).toBe('2026-09-05T10:00:00.000Z');
  });
});

describe('runHistoryItems', () => {
  const rows: RunHistoryRunRow[] = [
    { id: 'b', summary: 'Older', state: 'completed', progress: { summary: '3 of 3 steps completed.' }, created_at: '2026-09-04T10:00:00Z', completed_at: '2026-09-04T11:00:00Z', updated_at: '2026-09-04T11:00:00Z', request_id: null, plan_id: 'p-b', error: null },
    { id: 'a', summary: '  ', state: 'failed', progress: {}, created_at: '2026-09-05T10:00:00Z', completed_at: null, updated_at: '2026-09-05T10:00:00Z', request_id: 'req-a', plan_id: null, error: 'The calendar refused the write.' },
    { id: 'c', summary: 'Same instant', state: 'executing', progress: {}, created_at: '2026-09-05T10:00:00Z', completed_at: null, updated_at: '2026-09-05T10:00:00Z', request_id: 'req-c', plan_id: null, error: 'stale' },
  ];

  it('orders newest first with a stable id tie-break, and maps each row to what a person reads', () => {
    const items = runHistoryItems(rows);
    expect(items.map((i) => i.id)).toEqual(['a', 'c', 'b']);
    expect(runHistoryItems([...rows].reverse()).map((i) => i.id)).toEqual(['a', 'c', 'b']);
    expect(items[0]).toMatchObject({ title: null, state: 'failed', error: 'The calendar refused the write.', startedByRoutine: false, href: '/dashboard/concierge/runs/a' });
    // An error line only belongs to a run that failed or is blocked.
    expect(items[1].error).toBeNull();
    expect(items[2]).toMatchObject({ title: 'Older', startedByRoutine: true, detail: '3 of 3 steps completed.', finishedAt: '2026-09-04T11:00:00Z' });
  });

  it('carries the source and reason from evidence, and nothing without it', () => {
    const bare = runHistoryItems(rows);
    expect(bare.every((i) => i.sources.length === 0 && i.reason === null)).toBe(true);
    const items = runHistoryItems(rows, {
      steps: [{ id: 's1', plan_id: 'p-b', step_type: 'act', tool_name: 'tasks.createTask', status: 'completed' }],
      toolCalls: [{ run_id: 'b', plan_step_id: 's1', tool_name: 'tasks.createTask', state: 'succeeded', resource_table: 'todo_items' }],
      plans: [{ id: 'p-b', reasoning_summary: 'Three chores were unassigned.' }],
    });
    expect(items[2].sources).toEqual([{ tool: 'tasks.createTask', domain: 'tasks' }]);
    expect(items[2].reason).toBe('Three chores were unassigned.');
    expect(items[0].sources).toEqual([]);
  });
});

// ─── listRuns ────────────────────────────────────────────────────────────────

describe('listRuns', () => {
  function seeded() {
    const db = createInMemorySupabase();
    db.seed('family_automation_runs', [
      run('r-old', { created_at: '2026-09-01T10:00:00Z', state: 'completed' }),
      run('r-fail', { created_at: '2026-09-03T10:00:00Z', state: 'failed' }),
      run('r-wait', { created_at: '2026-09-04T10:00:00Z', state: 'awaiting_approval' }),
      run('r-new', { created_at: '2026-09-05T10:00:00Z', state: 'executing' }),
      run('r-other', { family_id: OTHER, created_at: '2026-09-05T12:00:00Z', state: 'completed' }),
    ]);
    return db as unknown as DB;
  }

  it('lists only this family, newest first', async () => {
    const db = seeded();
    const res = await listRuns(scopeForSystem(db, { id: FAM }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.map((r) => r.id)).toEqual(['r-new', 'r-wait', 'r-fail', 'r-old']);
    expect(res.data.every((r) => r.family_id === FAM)).toBe(true);

    const other = await listRuns(scopeForSystem(db, { id: OTHER }));
    expect(other.ok && other.data.map((r) => r.id)).toEqual(['r-other']);
  });

  it('filters by the states a chip names, pages with a before cursor, and clamps the limit', async () => {
    const db = seeded();
    const scope = scopeForSystem(db, { id: FAM });
    const done = await listRuns(scope, { states: RUN_HISTORY_FILTER_STATES.done });
    expect(done.ok && done.data.map((r) => r.id)).toEqual(['r-old']);
    const problems = await listRuns(scope, { states: RUN_HISTORY_FILTER_STATES.problems });
    expect(problems.ok && problems.data.map((r) => r.id)).toEqual(['r-fail']);
    const active = await listRuns(scope, { states: RUN_HISTORY_FILTER_STATES.active });
    expect(active.ok && active.data.map((r) => r.id)).toEqual(['r-new']);

    const older = await listRuns(scope, { before: '2026-09-04T10:00:00Z' });
    expect(older.ok && older.data.map((r) => r.id)).toEqual(['r-fail', 'r-old']);

    const one = await listRuns(scope, { limit: 0 });
    expect(one.ok && one.data.map((r) => r.id)).toEqual(['r-new']);
  });

  it('fails closed on a read error: a retryable failure, logged, never an empty list and never a throw', async () => {
    const err = quietErrors();
    const res = await listRuns(scopeForSystem(failingDb({ code: '57P01', message: 'terminating connection' }), { id: FAM }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.retryable).toBe(true);
    expect(res.error.length).toBeGreaterThan(0);
    expect(err.mock.calls.map((c) => String(c[0]))).toContain('[ai/runs] failed to list the runs');

    const thrown = await listRuns(scopeForSystem(failingDb(null, { throws: true }), { id: FAM }));
    expect(thrown.ok).toBe(false);
    expect(!thrown.ok && thrown.retryable).toBe(true);
    err.mockRestore();
  });
});

// ─── loadRunEvidence ─────────────────────────────────────────────────────────

describe('loadRunEvidence', () => {
  function seeded() {
    const db = createInMemorySupabase();
    db.seed('ai_plans', [
      { id: 'p1', family_id: FAM, reasoning_summary: 'Two free slots on Saturday.' },
      { id: 'p9', family_id: OTHER, reasoning_summary: 'Not yours.' },
    ]);
    db.seed('ai_plan_steps', [
      { id: 's1', family_id: FAM, plan_id: 'p1', sequence: 0, step_type: 'retrieve', tool_name: 'calendar.searchEvents', status: 'completed' },
      { id: 's2', family_id: FAM, plan_id: 'p1', sequence: 1, step_type: 'act', tool_name: 'calendar.createEvent', status: 'completed' },
      { id: 's9', family_id: OTHER, plan_id: 'p9', sequence: 0, step_type: 'act', tool_name: 'tasks.createTask', status: 'completed' },
    ]);
    db.seed('ai_tool_calls', [
      { id: 'c1', family_id: FAM, run_id: 'r1', plan_step_id: 's1', tool_name: 'calendar.searchEvents', state: 'succeeded', resource_table: null, idempotency_key: 'k1', created_at: '2026-09-05T10:00:01Z' },
      { id: 'c2', family_id: FAM, run_id: 'r1', plan_step_id: 's2', tool_name: 'calendar.createEvent', state: 'succeeded', resource_table: 'events', idempotency_key: 'k2', created_at: '2026-09-05T10:00:02Z' },
      { id: 'c3', family_id: FAM, run_id: 'r1', plan_step_id: 's2', tool_name: 'calendar.createEvent', state: 'failed', resource_table: null, idempotency_key: 'k3', created_at: '2026-09-05T10:00:03Z' },
      { id: 'c9', family_id: OTHER, run_id: 'r1', plan_step_id: 's9', tool_name: 'tasks.createTask', state: 'succeeded', resource_table: 'todo_items', idempotency_key: 'k9', created_at: '2026-09-05T10:00:04Z' },
    ]);
    return db as unknown as DB;
  }

  it('reads only this family, only succeeded calls, and only the plans the runs name', async () => {
    const res = await loadRunEvidence(seeded(), FAM, [{ id: 'r1', plan_id: 'p1' }]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.steps.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(res.data.toolCalls.map((c) => c.tool_name)).toEqual(['calendar.searchEvents', 'calendar.createEvent']);
    expect(res.data.toolCalls.every((c) => c.state === 'succeeded')).toBe(true);
    expect(res.data.plans).toEqual([{ id: 'p1', reasoning_summary: 'Two free slots on Saturday.' }]);
  });

  it('is empty for no runs, without touching the database', async () => {
    const res = await loadRunEvidence(failingDb({ message: 'must not be called' }), FAM, []);
    expect(res).toEqual({ ok: true, data: { steps: [], toolCalls: [], plans: [] } });
  });

  it('fails closed on a read error', async () => {
    const err = quietErrors();
    const res = await loadRunEvidence(failingDb({ message: 'relation ai_tool_calls is unavailable' }), FAM, [{ id: 'r1', plan_id: 'p1' }]);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.retryable).toBe(true);
    expect(err.mock.calls.map((c) => String(c[0]))).toContain('[ai/runs] run evidence read failed');
    err.mockRestore();
  });
});

// ─── loadCompletedByBubaly — the Home ledger read ────────────────────────────

describe('loadCompletedByBubaly', () => {
  function seeded() {
    const db = createInMemorySupabase();
    db.seed('family_automation_runs', [
      run('r1', { state: 'completed', plan_id: 'p1', summary: 'Organizing Saturday', progress: { summary: '2 of 2 steps completed.' }, completed_at: '2026-09-05T13:00:00Z', updated_at: '2026-09-05T13:00:00Z' }),
      run('r2', { state: 'partially_completed', plan_id: 'p2', summary: 'Remind everyone', progress: { summary: '1 of 2 steps completed — 1 failed.' }, completed_at: '2026-09-05T11:00:00Z', updated_at: '2026-09-05T11:00:00Z' }),
      run('r3', { state: 'executing', plan_id: 'p3', summary: 'Still going', completed_at: null, updated_at: '2026-09-05T13:30:00Z' }),
      run('r9', { family_id: OTHER, state: 'completed', plan_id: null, summary: 'Not yours', completed_at: '2026-09-05T13:45:00Z' }),
    ]);
    db.seed('agent_activity', [
      { id: 'a1', family_id: FAM, agent: 'scheduler', kind: 'action', status: 'done', title: 'Moved practice', detail: 'To 5pm', href: '/dashboard/calendar', created_at: '2026-09-05T12:00:00Z' },
      { id: 'a2', family_id: FAM, agent: 'scheduler', kind: 'action', status: 'active', title: 'Not done yet', detail: null, href: null, created_at: '2026-09-05T12:30:00Z' },
      { id: 'a3', family_id: FAM, agent: 'scheduler', kind: 'action', status: 'done', title: 'Too old', detail: null, href: null, created_at: '2026-09-01T12:00:00Z' },
      { id: 'a9', family_id: OTHER, agent: 'scheduler', kind: 'action', status: 'done', title: 'Not yours', detail: null, href: null, created_at: '2026-09-05T12:00:00Z' },
    ]);
    db.seed('autopilot_suggestions', [
      { id: 'su1', family_id: FAM, status: 'auto_executed', title: 'Reordered milk', created_at: '2026-09-05T12:15:00Z' },
      { id: 'su2', family_id: FAM, status: 'pending', title: 'Not executed', created_at: '2026-09-05T12:20:00Z' },
    ]);
    db.seed('ai_plans', [
      { id: 'p1', family_id: FAM, reasoning_summary: 'Two free slots on Saturday and the pool is open.' },
      { id: 'p2', family_id: FAM, reasoning_summary: null },
    ]);
    db.seed('ai_plan_steps', [
      { id: 's1', family_id: FAM, plan_id: 'p1', sequence: 0, step_type: 'retrieve', tool_name: 'calendar.searchEvents', status: 'completed' },
      { id: 's2', family_id: FAM, plan_id: 'p1', sequence: 1, step_type: 'act', tool_name: 'calendar.createEvent', status: 'completed' },
      { id: 's3', family_id: FAM, plan_id: 'p2', sequence: 0, step_type: 'notify', tool_name: 'messages.send', status: 'completed' },
      { id: 's4', family_id: FAM, plan_id: 'p2', sequence: 1, step_type: 'act', tool_name: 'tasks.createTask', status: 'failed' },
    ]);
    db.seed('ai_tool_calls', [
      { id: 'c1', family_id: FAM, run_id: 'r1', plan_step_id: 's1', tool_name: 'calendar.searchEvents', state: 'succeeded', resource_table: null, idempotency_key: 'k1', created_at: '2026-09-05T12:50:01Z' },
      { id: 'c2', family_id: FAM, run_id: 'r1', plan_step_id: 's2', tool_name: 'calendar.createEvent', state: 'succeeded', resource_table: 'events', idempotency_key: 'k2', created_at: '2026-09-05T12:50:02Z' },
    ]);
    return db as unknown as DB;
  }

  it('merges finished runs, done agent actions and auto-executed suggestions with source and reason, family-scoped', async () => {
    const res = await loadCompletedByBubaly(seeded(), FAM, { now: NOW });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.map((i) => i.key)).toEqual(['run:r1', 'activity:su1', 'activity:a1', 'run:r2']);

    const r1 = res.data[0];
    expect(r1.sources).toEqual([{ tool: 'calendar.createEvent', domain: 'calendar' }]); // the read never counts as acting
    expect(r1.reason).toBe('Two free slots on Saturday and the pool is open.');
    expect(r1.partial).toBe(false);

    const r2 = res.data[3];
    expect(r2.partial).toBe(true);
    expect(r2.sources).toEqual([{ tool: 'messages.send', domain: 'messages' }]); // no ledger rows: the completed notify step, not the failed act
    expect(r2.reason).toBeNull();

    expect(res.data[1]).toMatchObject({ kind: 'activity', href: '/dashboard/autopilot', sources: [{ tool: 'autopilot', domain: 'autopilot' }], reason: null });
    expect(res.data[2]).toMatchObject({ kind: 'activity', href: '/dashboard/calendar', sources: [{ tool: 'scheduler', domain: 'scheduler' }] });
  });

  it('fails closed on a read error — never a reassuring "nothing finished yet"', async () => {
    const err = quietErrors();
    const res = await loadCompletedByBubaly(failingDb({ message: 'timeout' }), FAM, { now: NOW });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.retryable).toBe(true);
    expect(err.mock.calls.map((c) => String(c[0]))).toContain('[home] completed by Bubaly read failed');

    const thrown = await loadCompletedByBubaly(failingDb(null, { throws: true }), FAM, { now: NOW });
    expect(thrown.ok).toBe(false);
    err.mockRestore();
  });
});

// ─── The surfaces, as source contracts ───────────────────────────────────────

function code(path: string): string {
  return fs.readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('run history surfaces', () => {
  const runsPage = code('app/(app)/dashboard/concierge/runs/page.tsx');
  const conciergePage = code('app/(app)/dashboard/concierge/page.tsx');
  const home = code('app/(app)/home/page.tsx');
  const dashboardHome = code('components/dashboard/ai-home-dashboard.tsx');

  it('the runs index reads through the caller client, family-scoped, and fails closed on either read', () => {
    expect(runsPage).toContain("import { listRuns } from '@/lib/ai/runs/store';");
    expect(runsPage).toContain('listRuns(scopeFromUserContext(ctx, supabase)');
    expect(runsPage).toContain('if (!listed.ok) return <Unavailable message={listed.error}');
    expect(runsPage).toContain('loadRunEvidence(supabase, familyId, rows)');
    expect(runsPage).toContain('if (!evidence.ok) return <Unavailable message={evidence.error}');
    expect(runsPage).toContain('states: RUN_HISTORY_FILTER_STATES[filter]');
    expect(runsPage).not.toContain('createServiceClient');
    // No inert Undo: reversal needs a migration, so nothing here pretends to offer it.
    expect(runsPage).not.toMatch(/undo/i);
  });

  it('is reachable from the concierge page and both Home variants, and never from the shared sidebar', () => {
    expect(conciergePage).toContain('href="/dashboard/concierge/runs"');
    expect(home).toContain('historyHref="/dashboard/concierge/runs"');
    expect(home).toContain('historyHref="/dashboard/concierge/runs?state=done"');
    expect(dashboardHome).toContain('historyHref="/dashboard/concierge/runs"');
    expect(dashboardHome).toContain('historyHref="/dashboard/concierge/runs?state=done"');
    for (const nav of ['lib/constants/navigation.ts', 'components/app/app-shell.tsx', 'components/app/nav-shared.tsx', 'components/app/free-tier-sidebar.tsx']) {
      if (!fs.existsSync(nav)) continue;
      expect(fs.readFileSync(nav, 'utf8'), nav).not.toContain('/dashboard/concierge/runs');
    }
  });

  it('both Home variants read the ledger through the fail-closed loader and show its failure', () => {
    for (const page of [home, dashboardHome]) {
      expect(page).toContain('loadCompletedByBubaly(supabase, familyId, { now, limit: 6 })');
      expect(page).toContain('const completedError = completedRes.ok ? null : completedRes.error;');
      expect(page).toContain('error={completedError}');
      expect(page).not.toContain('mergeCompletedByBubaly(');
    }
  });
});
