// GET /api/cron/family-routines, request-level (audit Register B).
//
// The routine worker over two open, paid households in different zones, plus
// the rules it must leave alone: a closed family's, a family that switched
// Bubaly off, a rule the family disabled, a rule not yet due, and an
// occurrence another worker already filed. Everything below the route is real
// — `hasCronAuthorization` with a stubbed secret, the strict settings read,
// the entitlement read, `createRequest`/`createRun`, `planRoutineRequest`
// (classify, context, planner), `kickRun` → `continueRun` → `claimRun` →
// executor → tasks service — over the in-memory database. Only the model is a
// stand-in at the routing seam (as in
// tests/a-routine-is-planned-before-it-is-filed.test.ts), and `after()` runs
// its callback here. The routines are weekend-prep plans, not reminders.
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AIProvider, AIStructuredInput } from '@/lib/ai/provider';
import { createInMemorySupabase, withFaults, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({
  db: null as unknown,
  after: [] as Promise<unknown>[],
  prompts: [] as string[],
  failFor: null as string | null,
  service: null as unknown as { mock: { calls: unknown[] }; mockClear: () => void },
}));
vi.mock('@/lib/supabase/server', async () => {
  const { vi: v } = await import('vitest');
  const service = v.fn(() => h.db);
  h.service = service;
  return { createServiceClient: service, createServer: async () => h.db };
});
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string, params?: Record<string, unknown>) => `${key}${params ? JSON.stringify(params) : ''}` }));
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: (task: () => Promise<unknown>) => { h.after.push(task()); },
}));

const MARKERS = ['Ames', 'Blake'] as const;
const planFor = (marker: string) => JSON.stringify({
  objective: 'Get the weekend ready.', reasoning_summary: 'One thing to pack before Saturday.', risk_level: 'low',
  steps: [{
    key: 'pack', step_type: 'act', tool_name: 'tasks.createTodo', description: 'Pack the picnic',
    input: JSON.stringify({ title: `${marker}: pack the picnic` }), depends_on: [], condition: null, approval_required: null, verify: null,
  }],
  followups: [], clarification: null, answer: null,
});
const provider: AIProvider = {
  id: 'stand-in', model: 'stand-in-model',
  complete: async () => { throw new Error('not used'); },
  runTools: async () => { throw new Error('not used'); },
  // eslint-disable-next-line require-yield
  runToolsStream: async function* () { throw new Error('not used'); },
  structuredCompletion: async ({ system, messages, schemaName }: AIStructuredInput) => {
    const text = JSON.stringify({ system, messages });
    h.prompts.push(text);
    const marker = MARKERS.find((m) => text.includes(`the ${m} weekend`)) ?? 'unknown';
    if (marker === h.failFor) throw new Error('model unavailable');
    return schemaName === 'request_intent'
      ? { text: JSON.stringify({ intent: 'organize_weekend', confidence: 0.9, entities: [] }), refusal: null, usage: null }
      : { text: planFor(marker), refusal: null, usage: null };
  },
};
vi.mock('@/lib/ai/routing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/routing')>()),
  resolveProviderForTask: async () => provider,
}));

const { GET: tick } = await import('@/app/api/cron/family-routines/route');

const SECRET = 'test-cron-secret-not-real';
// Saturday 2026-09-05, 15:00 UTC.
const NOW = new Date('2026-09-05T15:00:00Z');
const id = (n: string) => `00000000-0000-4000-8000-0000000c${n}`;

const AMES = { family: id('a0001'), member: id('a0002'), user: id('a0003'), rule: id('a0011'), due: '2026-09-05T13:00:00.000Z', next: '2026-09-12T13:00:00.000Z' };
const BLAKE = { family: id('b0001'), member: id('b0002'), user: id('b0003'), rule: id('b0011'), due: '2026-09-05T14:00:00.000Z', next: '2026-09-12T14:00:00.000Z' };
const CLOSED = { family: id('c0001'), rule: id('c0011') };
const PAUSED = { family: id('d0001'), rule: id('d0011'), next: '2026-09-12T13:00:00.000Z' };
// Ames's other rules: one the family disabled, one not due until tomorrow,
// and one whose occurrence another worker, still mid-tick, has just filed.
const DISABLED_RULE = id('a0012');
const LATER_RULE = id('a0013');
const FILED_RULE = id('a0014');
const FILED_REQUEST = id('a0021');

const rule = (ruleId: string, familyId: string, words: string, expr: string, nextRunAt: string, extra: Row = {}): Row => ({
  id: ruleId, family_id: familyId, name: words, action_config: { prompt: words }, schedule_kind: 'cron', schedule_expr: expr,
  anchor_key: null, offset_days: null, at_hour: null, said: 'every Saturday', is_enabled: true, next_run_at: nextRunAt, ...extra,
});

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

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.stubEnv('CRON_SECRET', SECRET);
  db = createInMemorySupabase({
    uniques: { routine_runs: [['rule_id', 'due_at']], ai_tool_calls: [['family_id', 'idempotency_key']] },
    defaults: {
      ai_requests: { status: 'queued', clarifications: [], error: null, started_at: null, completed_at: null, conversation_id: null },
      family_automation_runs: { attempt: 0, max_attempts: 5, lease_owner: null, lease_expires_at: null, cancel_requested_at: null, paused_at: null, error: null, plan_id: null, progress: {} },
      ai_plan_steps: { retry_count: 0, max_retries: 2, result_json: null, error: null, condition: null, approval_id: null },
      ai_tool_calls: { state: 'reserved', attempt: 1, outputs: null, error: null, finished_at: null },
      todo_items: { is_done: false, priority: 'medium', tags: [], sort_order: 0, completed_at: null, due_date: null, notes: null, assigned_to_id: null },
      todo_lists: { is_archived: false },
    },
  });
  calls = [];
  h.db = recorded(db);
  h.after = [];
  h.prompts = [];
  h.failFor = null;
  h.service.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  db.seed('families', [
    { id: AMES.family, name: 'The Ames', timezone: 'America/New_York', closed_at: null, trial_ends_at: null },
    { id: BLAKE.family, name: 'The Blakes', timezone: 'Asia/Tokyo', closed_at: null, trial_ends_at: null },
    { id: CLOSED.family, name: 'Closed', timezone: 'America/New_York', closed_at: '2026-09-01T00:00:00.000Z', trial_ends_at: null },
    { id: PAUSED.family, name: 'Paused', timezone: 'America/New_York', closed_at: null, trial_ends_at: null },
  ]);
  db.seed('family_members', [
    { id: AMES.member, family_id: AMES.family, user_id: AMES.user, role: 'parent', is_active: true, display_name: 'Dana Ames' },
    { id: BLAKE.member, family_id: BLAKE.family, user_id: BLAKE.user, role: 'parent', is_active: true, display_name: 'Lee Blake' },
  ]);
  db.seed('subscriptions', [AMES.family, BLAKE.family, CLOSED.family, PAUSED.family].map((familyId) => ({
    id: `sub-${familyId}`, family_id: familyId, plan: 'basic', status: 'active', current_period_end: '2099-01-01T00:00:00Z',
  })));
  db.seed('family_ai_settings', [
    { family_id: AMES.family, enabled: true, behavior: 'execute' },
    { family_id: BLAKE.family, enabled: true, behavior: 'execute' },
    { family_id: CLOSED.family, enabled: true, behavior: 'execute' },
    { family_id: PAUSED.family, enabled: false, behavior: 'execute' },
  ]);
  db.seed('family_automation_rules', [
    // Saturday 9:00 in New York, and Saturday 23:00 in Tokyo: both due.
    rule(AMES.rule, AMES.family, 'Organize the Ames weekend', '0 9 * * 6', AMES.due),
    rule(BLAKE.rule, BLAKE.family, 'Organize the Blake weekend', '0 23 * * 6', BLAKE.due),
    rule(CLOSED.rule, CLOSED.family, 'Organize the Closed weekend', '0 9 * * 6', AMES.due),
    rule(PAUSED.rule, PAUSED.family, 'Organize the Paused weekend', '0 9 * * 6', AMES.due),
    rule(DISABLED_RULE, AMES.family, 'Organize the Ames garage', '0 9 * * 6', AMES.due, { is_enabled: false }),
    rule(LATER_RULE, AMES.family, 'Organize the Ames Sunday', '0 9 * * 0', '2026-09-06T13:00:00.000Z'),
    rule(FILED_RULE, AMES.family, 'Organize the Ames attic', '0 9 * * 6', AMES.due),
  ]);
  db.seed('routine_runs', [{ id: id('a0031'), family_id: AMES.family, rule_id: FILED_RULE, due_at: AMES.due, status: 'filed', request_id: FILED_REQUEST, created_at: '2026-09-05T14:59:30.000Z' }]);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const get = (authorization?: string) => tick(new NextRequest('https://bubaly.test/api/cron/family-routines', authorization ? { headers: { authorization } } : {}));
const ruleRow = (ruleId: string) => db.table('family_automation_rules').find((r) => r.id === ruleId) as Row;
const occurrences = (ruleId: string) => db.table('routine_runs').filter((r) => r.rule_id === ruleId);
const requestsOf = (familyId: string) => db.table('ai_requests').filter((r) => r.family_id === familyId);
const runsOf = (familyId: string) => db.table('family_automation_runs').filter((r) => r.family_id === familyId);
const snapshot = () => JSON.stringify(['family_automation_rules', 'routine_runs', 'ai_requests', 'family_automation_runs', 'ai_plans', 'ai_plan_steps', 'todo_items'].map((t) => db.table(t)));

async function authorizedTick() {
  const res = await get(`Bearer ${SECRET}`);
  const body = await res.json();
  await Promise.all(h.after);
  return { status: res.status, body };
}

describe('GET /api/cron/family-routines', () => {
  it.each([
    ['no Authorization header', undefined],
    ['a wrong secret', 'Bearer not-the-cron-secret'],
  ])('API-A1B70253196E JOB-905AB0CFE100: refuses %s with 401 before any read, write or model call', async (_label, authorization) => {
    const before = snapshot();

    const res = await get(authorization);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'familyRoutines.unauthorized' });
    expect(h.service.mock.calls).toHaveLength(0);
    expect(calls).toEqual([]);
    expect(h.prompts).toEqual([]);
    expect(h.after).toEqual([]);
    expect(snapshot()).toBe(before);
  });

  it('API-A1B70253196E JOB-905AB0CFE100: with the right secret, files, plans and runs each open household’s due routine and skips the rest', async () => {
    const { status, body } = await authorizedTick();

    expect(status).toBe(200);
    // Ames, Blake, Paused and the already-filed rule are due; the closed family's is not read at all.
    expect(body).toMatchObject({ ok: true, considered: 4, armed: 0, filed: 2, skipped: 2, problems: 0 });

    for (const x of [AMES, BLAKE]) {
      const [request] = requestsOf(x.family);
      expect(requestsOf(x.family)).toHaveLength(1);
      expect(request).toMatchObject({ kind: 'routine', status: 'completed' });
      expect(occurrences(x.rule)).toEqual([expect.objectContaining({ family_id: x.family, due_at: x.due, status: 'filed', request_id: request.id })]);
      expect(runsOf(x.family).filter((r) => r.state !== 'cancelled')).toEqual([expect.objectContaining({ request_id: request.id, state: 'completed' })]);
      // The next occurrence, in the family's own zone.
      expect(ruleRow(x.rule)).toMatchObject({ next_run_at: x.next, last_run_at: NOW.toISOString() });
    }
    expect(db.table('todo_items').map((t) => [t.family_id, t.title]).sort()).toEqual([
      [AMES.family, 'Ames: pack the picnic'],
      [BLAKE.family, 'Blake: pack the picnic'],
    ]);

    // The closed family: nothing filed, nothing reserved, the rule untouched.
    expect(occurrences(CLOSED.rule)).toEqual([]);
    expect(requestsOf(CLOSED.family)).toEqual([]);
    expect(ruleRow(CLOSED.rule)).toMatchObject({ next_run_at: AMES.due });
    expect(ruleRow(CLOSED.rule).last_run_at ?? null).toBeNull();
    // Bubaly switched off: the occurrence is stamped skipped and the rule moves on, kept.
    expect(occurrences(PAUSED.rule)).toEqual([expect.objectContaining({ status: 'skipped', detail: 'Bubaly is switched off for this family.' })]);
    expect(requestsOf(PAUSED.family)).toEqual([]);
    expect(ruleRow(PAUSED.rule).next_run_at).toBe(PAUSED.next);
    // Disabled, and not yet due: untouched.
    expect(occurrences(DISABLED_RULE)).toEqual([]);
    expect(ruleRow(DISABLED_RULE)).toMatchObject({ next_run_at: AMES.due });
    expect(occurrences(LATER_RULE)).toEqual([]);
    expect(ruleRow(LATER_RULE)).toMatchObject({ next_run_at: '2026-09-06T13:00:00.000Z' });
    // Another worker's filed occurrence: not filed a second time.
    expect(occurrences(FILED_RULE)).toEqual([expect.objectContaining({ status: 'filed', request_id: FILED_REQUEST })]);
    expect(db.table('ai_requests').map((r) => r.request_text).sort()).toEqual(['Organize the Ames weekend', 'Organize the Blake weekend']);
  });

  it('API-A1B70253196E JOB-905AB0CFE100: nothing of one household reaches the other’s planner, plan or rows', async () => {
    await authorizedTick();

    // Every model call was about exactly one household.
    expect(h.prompts.length).toBeGreaterThanOrEqual(4);
    const about = (marker: string) => h.prompts.filter((p) => p.includes(`the ${marker} weekend`));
    expect(about('Ames').length + about('Blake').length).toBe(h.prompts.length);
    for (const p of about('Ames')) expect(p).not.toMatch(/Blake/);
    for (const p of about('Blake')) expect(p).not.toMatch(/Ames/);

    // Every row filed under a household carries that household's id and words.
    for (const [x, own, other] of [[AMES, 'Ames', 'Blake'], [BLAKE, 'Blake', 'Ames']] as const) {
      const tables = ['ai_requests', 'family_automation_runs', 'ai_plans', 'ai_plan_steps', 'todo_items', 'routine_runs'];
      const rows = tables.flatMap((t) => db.table(t).filter((r) => r.family_id === x.family));
      expect(JSON.stringify(rows)).not.toContain(other);
      expect(JSON.stringify(rows)).toContain(own);
      const [request] = requestsOf(x.family);
      const plan = db.table('ai_plans').find((p) => p.request_id === request.id) as Row;
      expect(plan.family_id).toBe(x.family);
      expect(db.table('ai_plan_steps').filter((s) => s.plan_id === plan.id).every((s) => s.family_id === x.family)).toBe(true);
    }
  });

  it('API-A1B70253196E JOB-905AB0CFE100: a second tick files nothing new, and a racing worker on the same occurrence does nothing', async () => {
    await authorizedTick();
    const after = snapshot();
    const modelCalls = h.prompts.length;

    const again = await authorizedTick();
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ ok: true, filed: 0, problems: 0 });
    expect(snapshot()).toBe(after);
    expect(h.prompts).toHaveLength(modelCalls);

    // A worker that read the rule before it moved: the reservation refuses it.
    Object.assign(ruleRow(AMES.rule), { next_run_at: AMES.due });
    const raced = await authorizedTick();
    expect(raced.body).toMatchObject({ filed: 0, problems: 0 });
    expect(requestsOf(AMES.family)).toHaveLength(1);
    expect(occurrences(AMES.rule)).toHaveLength(1);
    expect(db.table('todo_items')).toHaveLength(2);
    expect(h.prompts).toHaveLength(modelCalls);
  });

  it('API-A1B70253196E JOB-905AB0CFE100: a household whose planning fails is reported, and the other household still files', async () => {
    h.failFor = 'Ames';

    const { status, body } = await authorizedTick();

    expect(status).toBe(502);
    expect(body).toMatchObject({ ok: false, filed: 1, problems: 1 });
    expect(occurrences(AMES.rule)).toEqual([expect.objectContaining({ status: 'failed', request_id: requestsOf(AMES.family)[0].id })]);
    expect(requestsOf(AMES.family)[0].status).toBe('failed');
    expect(db.table('todo_items').filter((t) => t.family_id === AMES.family)).toEqual([]);
    // The rule still moves on, so one failure costs one occurrence, not the routine.
    expect(ruleRow(AMES.rule).next_run_at).toBe(AMES.next);
    // Blake is untouched by it.
    expect(occurrences(BLAKE.rule)).toEqual([expect.objectContaining({ status: 'filed' })]);
    expect(db.table('todo_items').filter((t) => t.family_id === BLAKE.family).map((t) => t.title)).toEqual(['Blake: pack the picnic']);
  });

  it('API-A1B70253196E JOB-905AB0CFE100: a failed read of the families’ zones files nothing and answers 500', async () => {
    h.db = recorded(withFaults(db, (table, made) => (
      table === 'families' && made.some((c) => c.method === 'select' && String(c.args[0]).includes('timezone'))
        ? { message: 'canceling statement due to statement timeout' } : null)));
    const before = snapshot();

    const res = await get(`Bearer ${SECRET}`);
    await Promise.all(h.after);

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'familyRoutines.couldNotReadRoutines' });
    expect(snapshot()).toBe(before);
    expect(h.prompts).toEqual([]);
  });

  it('API-A1B70253196E JOB-905AB0CFE100: a failed read of the due routines answers 500, not an empty success', async () => {
    h.db = recorded(withFaults(db, (table, made) => (
      table === 'family_automation_rules' && made.some((c) => c.method === 'lte') ? { message: 'connection reset by peer' } : null)));
    const before = snapshot();

    const res = await get(`Bearer ${SECRET}`);

    expect(res.status).toBe(500);
    expect(snapshot()).toBe(before);
    expect(h.prompts).toEqual([]);
  });
});
