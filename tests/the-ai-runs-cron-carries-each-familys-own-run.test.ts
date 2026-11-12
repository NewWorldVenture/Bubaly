// GET /api/cron/ai-runs, request-level (audit Register B).
//
// The continuation worker over two open, paid households plus the runs it must
// leave alone: a closed family's, a family on Free, and runs that are not due
// (already completed, or not due until tomorrow). Everything below the route is
// real — `hasCronAuthorization` with a stubbed secret, `claimRuns`, the
// entitlement read, `runGraph` → executor → `executeTool` → the tasks service —
// over the in-memory database, with `claim_ai_runs` emulated predicate for
// predicate as tests/a-run-that-threw-is-not-stranded.test.ts does. The model
// is a stand-in at the routing seam and must never be called: these plans need
// no replan.
import { randomUUID } from 'node:crypto';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AIProvider } from '@/lib/ai/provider';
import { createInMemorySupabase, withFaults, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({ db: null as unknown, modelCalls: 0, service: null as unknown as { mock: { calls: unknown[] } } }));
vi.mock('@/lib/supabase/server', async () => {
  const { vi: v } = await import('vitest');
  const service = v.fn(() => h.db);
  h.service = service;
  return { createServiceClient: service, createServer: async () => h.db };
});
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
const provider: AIProvider = {
  id: 'stand-in', model: 'stand-in-model',
  complete: async () => { h.modelCalls += 1; throw new Error('not used'); },
  runTools: async () => { h.modelCalls += 1; throw new Error('not used'); },
  // eslint-disable-next-line require-yield
  runToolsStream: async function* () { h.modelCalls += 1; throw new Error('not used'); },
  structuredCompletion: async () => { h.modelCalls += 1; throw new Error('not used'); },
};
vi.mock('@/lib/ai/routing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/routing')>()),
  resolveProviderForTask: async () => provider,
}));

const { GET: tick } = await import('@/app/api/cron/ai-runs/route');

const SECRET = 'test-cron-secret-not-real';
const NOW = Date.parse('2026-10-14T12:00:00Z');
const DAY = 24 * 60 * 60_000;

type Household = { family: string; member: string; user: string; request: string; plan: string; run: string; title: string };
const household = (n: string, title: string): Household => ({
  family: `00000000-0000-4000-8000-0000000b${n}001`,
  member: `00000000-0000-4000-8000-0000000b${n}002`,
  user: `00000000-0000-4000-8000-0000000b${n}003`,
  request: `00000000-0000-4000-8000-0000000b${n}004`,
  plan: `00000000-0000-4000-8000-0000000b${n}005`,
  run: `00000000-0000-4000-8000-0000000b${n}006`,
  title,
});
const AMES = household('a', 'Ames: pack the soccer kit');
const BLAKE = household('b', 'Blake: book the piano lesson');
const CLOSED = household('c', 'Closed: water the plants');
const FREE = household('d', 'Free: buy the birthday card');
// Not due: one finished yesterday, one parked until tomorrow.
const DONE_RUN = '00000000-0000-4000-8000-0000000ba007';
const LATER_RUN = '00000000-0000-4000-8000-0000000ba008';

/** `claim_ai_runs` as 0263 writes it (see tests/a-run-that-threw-is-not-stranded.test.ts). */
function claimAiRuns(args: Record<string, unknown>, mem: InMemorySupabase): string[] {
  const limit = Math.max(1, Math.min(Number(args.p_limit ?? 10), 50));
  const leaseSeconds = Math.max(30, Math.min(Number(args.p_lease_seconds ?? 120), 900));
  const now = Date.now();
  const rows = mem.table('family_automation_runs') as Array<Row & { id: string }>;
  for (const r of rows) {
    if (r.state !== 'executing' || r.lease_expires_at == null || Date.parse(String(r.lease_expires_at)) >= now) continue;
    const dead = Number(r.attempt) >= Number(r.max_attempts);
    Object.assign(r, {
      state: dead ? 'failed' : 'ready', status: dead ? 'failed' : r.status,
      lease_owner: null, lease_expires_at: null, run_after: new Date(now).toISOString(),
    });
  }
  const candidates = rows
    .filter((r) => (r.state === 'ready' || r.state === 'scheduled_followup')
      && Date.parse(String(r.run_after)) <= now
      && (r.lease_expires_at == null || Date.parse(String(r.lease_expires_at)) < now)
      && r.cancel_requested_at == null)
    .sort((a, b) => String(a.run_after).localeCompare(String(b.run_after)))
    .slice(0, limit);
  for (const r of candidates) {
    Object.assign(r, {
      state: 'executing', attempt: Number(r.attempt) + 1, lease_owner: randomUUID(),
      lease_expires_at: new Date(now + leaseSeconds * 1000).toISOString(), started_at: r.started_at ?? new Date(now).toISOString(),
    });
  }
  return candidates.map((r) => r.id);
}

let db: InMemorySupabase;
let calls: string[];

/** The database the route is handed, recording every table and function it touches. */
function recorded(client: object): object {
  return new Proxy(client, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if ((property === 'from' || property === 'rpc') && typeof value === 'function') {
        return (name: string, ...rest: unknown[]) => { calls.push(`${String(property)}:${name}`); return value.call(target, name, ...rest); };
      }
      return value;
    },
  });
}

function seedHousehold(x: Household, family: Row = {}) {
  db.seed('families', [{ id: x.family, name: x.title.split(':')[0], timezone: 'UTC', trial_ends_at: null, closed_at: null, ...family }]);
  db.seed('family_members', [{ id: x.member, family_id: x.family, user_id: x.user, role: 'parent', is_active: true, display_name: `${x.title.split(':')[0]} parent` }]);
  db.seed('ai_requests', [{ id: x.request, family_id: x.family, requested_by: x.user, requested_by_member_id: x.member, kind: 'concierge', request_text: x.title, status: 'ready' }]);
  db.seed('ai_plans', [{ id: x.plan, family_id: x.family, request_id: x.request, version: 1, status: 'approved', risk_level: 'low' }]);
  db.seed('ai_plan_steps', [{
    id: `${x.plan.slice(0, -3)}0f1`, family_id: x.family, plan_id: x.plan, sequence: 0, step_type: 'act', tool_name: 'tasks.createTodo', description: x.title,
    input_json: { title: x.title }, dependency_ids: [], condition: null, status: 'queued', approval_required: false, approval_id: null,
    risk_level: 'low', retry_count: 0, max_retries: 0, result_json: null, error: null,
  }]);
  db.seed('family_automation_runs', [{
    id: x.run, family_id: x.family, plan_id: x.plan, request_id: x.request, run_type: 'concierge', state: 'ready', status: 'approved',
    requested_by_member_id: x.member, created_by: x.user, attempt: 0, max_attempts: 5, lease_owner: null, lease_expires_at: null,
    cancel_requested_at: null, paused_at: null, progress: {}, started_at: null, completed_at: null, error: null, summary: null,
    run_after: new Date(NOW - 60_000).toISOString(),
  }]);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.stubEnv('CRON_SECRET', SECRET);
  db = createInMemorySupabase({
    rpc: { claim_ai_runs: claimAiRuns },
    uniques: { ai_tool_calls: [['family_id', 'idempotency_key']] },
    defaults: {
      ai_tool_calls: { state: 'reserved', attempt: 1, outputs: null, error: null, finished_at: null },
      todo_items: { is_done: false, priority: 'medium', tags: [], sort_order: 0, completed_at: null, due_date: null, notes: null, assigned_to_id: null },
      todo_lists: { is_archived: false },
    },
  });
  calls = [];
  h.db = recorded(db);
  h.modelCalls = 0;
  (h.service as unknown as { mockClear: () => void }).mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  seedHousehold(AMES);
  seedHousehold(BLAKE);
  seedHousehold(CLOSED, { closed_at: new Date(NOW - 3 * DAY).toISOString() });
  seedHousehold(FREE);
  // Ames, Blake and the closed family pay for Family Basic; Free does not.
  db.seed('subscriptions', [AMES, BLAKE, CLOSED].map((x) => ({
    id: `sub-${x.family}`, family_id: x.family, plan: 'basic', status: 'active', current_period_end: '2099-01-01T00:00:00Z',
  })));
  const ames = db.table('family_automation_runs').find((r) => r.id === AMES.run) as Row;
  db.seed('family_automation_runs', [
    { ...ames, id: DONE_RUN, state: 'completed', status: 'executed', attempt: 1, completed_at: new Date(NOW - DAY).toISOString() },
    { ...ames, id: LATER_RUN, run_after: new Date(NOW + DAY).toISOString() },
  ]);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const get = (authorization?: string) => tick(new NextRequest('https://bubaly.test/api/cron/ai-runs', authorization ? { headers: { authorization } } : {}));
const run = (id: string) => db.table('family_automation_runs').find((r) => r.id === id) as Row;
const todos = () => db.table('todo_items').map((t) => ({ family_id: t.family_id, title: String(t.title) }));
const snapshot = () => JSON.stringify(['family_automation_runs', 'todo_items', 'ai_tool_calls', 'ai_plan_steps', 'ai_requests'].map((t) => db.table(t)));

describe('GET /api/cron/ai-runs', () => {
  it.each([
    ['no Authorization header', undefined],
    ['a wrong secret', 'Bearer not-the-cron-secret'],
  ])('API-9BCA8F281320 JOB-65B62EEA3CA1: refuses %s with 401 before any read, write or model call', async (_label, authorization) => {
    const before = snapshot();

    const res = await get(authorization);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'aiRuns.unauthorized' });
    expect(h.service.mock.calls).toHaveLength(0);
    expect(calls).toEqual([]);
    expect(h.modelCalls).toBe(0);
    expect(snapshot()).toBe(before);
  });

  it('API-9BCA8F281320 JOB-65B62EEA3CA1: with the right secret, runs the two paid households’ due runs and defers the closed and Free families’', async () => {
    const res = await get(`Bearer ${SECRET}`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      ok: true, claimed: 4, executed: 2, runFailures: 0, requeueFailures: 0, deferredClosed: 1, deferredUnentitled: 1, returnedToQueue: 0,
    });
    expect(body.results.map((r: { runId: string }) => r.runId).sort()).toEqual([AMES.run, BLAKE.run].sort());
    expect(body.results.every((r: { status: string }) => r.status === 'completed')).toBe(true);

    // The two paid households' plans ran to the end, each writing its own to-do.
    expect(run(AMES.run)).toMatchObject({ state: 'completed', lease_owner: null });
    expect(run(BLAKE.run)).toMatchObject({ state: 'completed', lease_owner: null });
    expect(todos().sort((a, b) => a.title.localeCompare(b.title))).toEqual([
      { family_id: AMES.family, title: AMES.title },
      { family_id: BLAKE.family, title: BLAKE.title },
    ]);
    // The closed and the Free family's runs are put back a day out, attempt unspent, not cancelled.
    for (const x of [CLOSED, FREE]) {
      expect(run(x.run)).toMatchObject({ state: 'ready', lease_owner: null, lease_expires_at: null, attempt: 0 });
      expect(Date.parse(String(run(x.run).run_after))).toBe(NOW + DAY);
    }
    // Not due: untouched.
    expect(run(DONE_RUN)).toMatchObject({ state: 'completed', attempt: 1 });
    expect(run(LATER_RUN)).toMatchObject({ state: 'ready', attempt: 0, lease_owner: null });
    expect(h.modelCalls).toBe(0);
  });

  it('API-9BCA8F281320 JOB-65B62EEA3CA1: nothing derived from one household is written under another', async () => {
    await get(`Bearer ${SECRET}`);

    for (const x of [AMES, BLAKE]) {
      const own = db.table('todo_items').filter((t) => t.title === x.title);
      expect(own.map((t) => t.family_id)).toEqual([x.family]);
      const toolCalls = db.table('ai_tool_calls').filter((c) => c.family_id === x.family);
      expect(toolCalls).toHaveLength(1);
      expect(JSON.stringify(toolCalls)).not.toContain(x === AMES ? BLAKE.title : AMES.title);
      expect(db.table('todo_lists').filter((l) => l.family_id === x.family)).toHaveLength(1);
    }
    // Nothing at all was written for the families the tick set aside.
    for (const x of [CLOSED, FREE]) {
      expect(db.table('todo_items').filter((t) => t.family_id === x.family)).toEqual([]);
      expect(db.table('ai_tool_calls').filter((c) => c.family_id === x.family)).toEqual([]);
      expect(db.table('ai_plan_steps').find((s) => s.family_id === x.family)).toMatchObject({ status: 'queued' });
    }
    // Every row the tick created belongs to a household it ran.
    const written = [...db.table('todo_items'), ...db.table('todo_lists'), ...db.table('ai_tool_calls')].map((r) => r.family_id);
    expect([...new Set(written)].sort()).toEqual([AMES.family, BLAKE.family].sort());
  });

  it('API-9BCA8F281320 JOB-65B62EEA3CA1: a second tick claims nothing and writes nothing new', async () => {
    await get(`Bearer ${SECRET}`);
    const after = snapshot();
    vi.setSystemTime(NOW + 5 * 60_000);

    const res = await get(`Bearer ${SECRET}`);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, claimed: 0, executed: 0, deferredClosed: 0, deferredUnentitled: 0, results: [] });
    expect(snapshot()).toBe(after);
    expect(todos()).toHaveLength(2);
  });

  it('API-9BCA8F281320 JOB-65B62EEA3CA1: a failed read of which families are closed runs nothing, hands the wave back, and answers 502', async () => {
    h.db = recorded(withFaults(db, (table, made) => (table === 'families' && made.some((c) => c.method === 'not') ? { message: 'canceling statement due to statement timeout' } : null)));

    const res = await get(`Bearer ${SECRET}`);
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body).toMatchObject({ ok: false, claimed: 4, executed: 0, returnedToQueue: 4, deferredClosed: 0, deferredUnentitled: 0 });
    expect(db.table('todo_items')).toEqual([]);
    for (const x of [AMES, BLAKE, CLOSED, FREE]) {
      // Back in the queue now — not a day out, and with the claim's attempt returned.
      expect(run(x.run)).toMatchObject({ state: 'ready', lease_owner: null, attempt: 0 });
      expect(Date.parse(String(run(x.run).run_after))).toBe(NOW);
    }
  });

  it('API-9BCA8F281320 JOB-65B62EEA3CA1: a failed claim answers 502 without a success built on it', async () => {
    const failing = new Proxy(db, {
      get(target, property, receiver) {
        if (property === 'rpc') return async () => ({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout', details: null, hint: null } });
        return Reflect.get(target, property, receiver);
      },
    });
    h.db = recorded(failing);

    const res = await get(`Bearer ${SECRET}`);

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, claimed: 0, executed: 0 });
    expect(db.table('todo_items')).toEqual([]);
  });

  it('API-9BCA8F281320 JOB-65B62EEA3CA1: one household’s failing write does not stop the other’s run', async () => {
    h.db = recorded(withFaults(db, (table, made) => (
      table === 'todo_items' && made.some((c) => c.method === 'insert' && JSON.stringify(c.args).includes(AMES.family))
        ? { message: 'connection reset by peer' } : null)));

    const res = await get(`Bearer ${SECRET}`);
    const body = await res.json();

    // Blake's run is untouched by Ames's failure.
    expect(run(BLAKE.run)).toMatchObject({ state: 'completed' });
    expect(todos()).toEqual([{ family_id: BLAKE.family, title: BLAKE.title }]);
    // Ames's run is recorded as failed, with the step's error, and the tick lists it so —
    // not as completed. (A run that failed its own step is the run's outcome, not a tick
    // failure: `runFailures` counts only runs that threw or could not be loaded.)
    expect(run(AMES.run)).toMatchObject({ state: 'failed', lease_owner: null });
    expect(String(run(AMES.run).error)).toContain('1 failed');
    expect(db.table('ai_plan_steps').find((s) => s.family_id === AMES.family)).toMatchObject({ status: 'failed' });
    expect(body.results).toContainEqual({ runId: AMES.run, status: 'failed', completed: 0, failed: 1 });
    expect(body.results).toContainEqual({ runId: BLAKE.run, status: 'completed', completed: 1, failed: 0 });
    expect(body).toMatchObject({ executed: 2, runFailures: 0 });
    expect(res.status).toBe(200);
  });
});
