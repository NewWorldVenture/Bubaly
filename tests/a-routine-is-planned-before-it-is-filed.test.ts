// N2 / N4 — a family routine filed a run nothing would ever run.
//
// For each due routine the cron filed an `ai_requests` row and a run in
// `queued` with no plan, kicked it and counted it filed. Nothing plans a
// `routine` request, and `claimRun` / `claim_ai_runs` only take `ready` and
// `scheduled_followup` runs, so the kick claimed nothing: "every Sunday, plan
// our meals" never happened, the request sat `queued` (counted by the Free
// plan's monthly meter) and the run sat under "In progress" for ever, while
// `routine_runs` said `filed` and the tick answered 200.
//
// The cron now plans the occurrence — the intake's classify, context and
// planner steps — and attaches the plan to its run before handing it on, and
// counts it filed only then. This drives the real cron route, the real intake
// and planner, the real `kickRun` → `continueRun` → `claimRun` → executor →
// tools → tasks service, over the in-memory database. Only the model is a
// stand-in, and `after()` (which needs a live request) runs its callback here.
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { AIProvider } from '@/lib/ai/provider';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({ db: null as unknown, after: [] as Promise<unknown>[], reply: '' as string }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db, createServer: async () => h.db }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string, params?: Record<string, unknown>) => `${key}${params ? JSON.stringify(params) : ''}` }));
vi.mock('@/lib/server/cron-auth', () => ({ hasCronAuthorization: () => true }));
vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: (task: () => Promise<unknown>) => { h.after.push(task()); },
}));
const provider: AIProvider = {
  id: 'stand-in', model: 'stand-in-model',
  complete: async () => { throw new Error('not used'); },
  runTools: async () => { throw new Error('not used'); },
  // eslint-disable-next-line require-yield
  runToolsStream: async function* () { throw new Error('not used'); },
  structuredCompletion: async ({ schemaName }) => schemaName === 'request_intent'
    ? { text: JSON.stringify({ intent: 'organize_weekend', confidence: 0.9, entities: [] }), refusal: null, usage: null }
    : { text: h.reply, refusal: null, usage: null },
};
vi.mock('@/lib/ai/routing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/routing')>()),
  resolveProviderForTask: async () => provider,
}));

const { GET: tick } = await import('@/app/api/cron/family-routines/route');

const FAMILY = '00000000-0000-4000-8000-0000000c2a01';
const RULE = '00000000-0000-4000-8000-0000000c2a11';
const NOW = new Date('2026-09-05T15:00:00Z');

const planReply = JSON.stringify({
  objective: 'Get the weekend ready.', reasoning_summary: 'One thing to pack before Saturday.', risk_level: 'low',
  steps: [{
    key: 'pack', step_type: 'act', tool_name: 'tasks.createTodo', description: 'Pack the picnic',
    input: JSON.stringify({ title: 'Pack the picnic' }), depends_on: [], condition: null, approval_required: null, verify: null,
  }],
  followups: [], clarification: null, answer: null,
});

let db: InMemorySupabase;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
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
  h.db = db;
  h.after = [];
  h.reply = planReply;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  db.seed('families', [{ id: FAMILY, name: 'The Riveras', timezone: 'America/New_York', closed_at: null, trial_ends_at: null }]);
  db.seed('family_ai_settings', [{ family_id: FAMILY, enabled: true, behavior: 'execute' }]);
  db.seed('family_automation_rules', [{
    id: RULE, family_id: FAMILY, name: 'Weekend prep', action_config: { prompt: 'Organize our weekend' }, schedule_kind: 'cron',
    schedule_expr: '0 9 * * 6', anchor_key: null, offset_days: null, at_hour: null, said: 'every Saturday at 9', is_enabled: true,
    next_run_at: '2026-09-05T13:00:00.000Z',
  }]);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const request = () => new NextRequest('https://bubaly.test/api/cron/family-routines', { headers: { authorization: 'Bearer x' } });
const occurrence = () => db.table('routine_runs')[0] as Row;
const requests = () => db.table('ai_requests');
const runs = () => db.table('family_automation_runs');

describe('a due routine', () => {
  it('is planned, handed on, and actually runs', async () => {
    const res = await tick(request());
    const body = await res.json();
    await Promise.all(h.after);

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ filed: 1, problems: 0 });
    expect(requests()).toHaveLength(1);
    expect(occurrence()).toMatchObject({ status: 'filed', request_id: requests()[0].id });
    // The run the cron filed carries the plan, and the kick ran it to the end.
    const live = runs().filter((r) => r.state !== 'cancelled');
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ request_id: requests()[0].id, state: 'completed' });
    expect(live[0].plan_id).toBeTruthy();
    expect(db.table('todo_items').map((t) => t.title)).toEqual(['Pack the picnic']);
    expect(requests()[0].status).toBe('completed');
  });

  it('that cannot be planned is a failure: request, run and occurrence say so, and the tick answers 502', async () => {
    h.reply = JSON.stringify({ objective: 'Ask', reasoning_summary: 'Which weekend?', risk_level: 'low', steps: [], followups: [], clarification: { question: 'Which weekend?', reason: 'Two fit.' }, answer: null });

    const res = await tick(request());
    const body = await res.json();
    await Promise.all(h.after);

    expect(res.status).toBe(502);
    expect(body).toMatchObject({ filed: 0, problems: 1 });
    expect(occurrence()).toMatchObject({ status: 'failed', request_id: requests()[0].id });
    expect(String(occurrence().detail)).toContain('Which weekend?');
    expect(requests()[0].status).toBe('failed');
    // Nothing is left looking "in progress".
    expect(runs().filter((r) => !['failed', 'cancelled', 'completed'].includes(String(r.state)))).toEqual([]);
    // The rule still moves on to its next occurrence.
    expect(db.table('family_automation_rules')[0].next_run_at).not.toBe('2026-09-05T13:00:00.000Z');
  });
});
