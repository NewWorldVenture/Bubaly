// A planner the intake gave up on keeps nothing it produces.
//
// The intake races the planner against a 20-second budget and, when the
// budget wins, tells the person to try again. The planner keeps running.
//
// N3 — On the answer path the request goes back to `awaiting_context`, and
// answering again moves it back to `planning`. The first planner's
// compare-and-set was on the STATUS alone, so when it finished during the
// retry it found `planning` — the retry's — and kept its plan: a ready run
// nobody was watching executed, and the retry's own plan was cancelled.
//
// N9 — Only the plan outcome was fenced at all. A late recommendation filed its
// card and flipped a request the person had been told failed to `completed`
// (their retry is a new request, so the card was filed twice); a late question
// or answer set the request's status unconditionally.
//
// N3, the window — the planner created its run `ready` BEFORE the fence that
// decides whether the attempt's plan is kept. A cron claim in that gap leased
// a run the abandoned planner then marked `cancelled` without the
// `cancel_requested_at` a worker re-reads between batches, so the worker ran
// the plan anyway. The run is now created `planning`, which nothing claims,
// and opened only once the fence holds.
//
// Each planning attempt now writes its own mark on the request and keeps an
// outcome only while that mark is still there. Driven through the real intake
// and the real planner (validator, store, trust dry run) over the in-memory
// database; only the model is a stand-in, held so the budget runs out.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { AIProvider } from '@/lib/ai/provider';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

const FAMILY = '00000000-0000-4000-8000-0000000e3a01';
const USER = '00000000-0000-4000-8000-0000000e3a11';
const PARENT = '00000000-0000-4000-8000-0000000e3a21';
const RUN = '00000000-0000-4000-8000-0000000e3a31';
const REQUEST = '00000000-0000-4000-8000-0000000e3a41';
const NOW = new Date('2026-09-05T15:00:00Z');

/** One model reply the test lets go of when it chooses. */
type Held = { schemaName: string; release: () => void };
const h = vi.hoisted(() => ({
  client: null as unknown,
  held: [] as Held[],
  planners: [] as Promise<unknown>[],
  reply: '' as string,
}));

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.client, createServer: async () => h.client }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
// The real planner, with a handle on each attempt so the test can wait for a
// late one to finish.
vi.mock('@/lib/ai/planner', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/ai/planner')>();
  return { ...real, planRequest: (...args: Parameters<typeof real.planRequest>) => { const p = real.planRequest(...args); h.planners.push(p); return p; } };
});
vi.mock('@/lib/ai/context/builder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/context/builder')>()),
  buildContext: async () => ({ ok: true, data: {
    header: { familyName: 'The Riveras', tz: 'America/New_York', locale: 'en-US', currency: 'USD', nowIso: NOW.toISOString(), todayKey: '2026-09-05', viewerRole: 'parent', viewerName: 'Dana' },
    slices: { people: { members: [{ id: PARENT, name: 'Dana', role: 'parent', canManage: true }] } },
    stats: {}, sensitiveOmitted: [], text: 'Family: The Riveras',
  } }),
}));
// The model: every plan call waits for the test; a classification answers at once.
const provider: AIProvider = {
  id: 'held', model: 'held-model',
  complete: async () => { throw new Error('not used'); },
  runTools: async () => { throw new Error('not used'); },
  // eslint-disable-next-line require-yield
  runToolsStream: async function* () { throw new Error('not used'); },
  structuredCompletion: async ({ schemaName }) => {
    if (schemaName === 'request_intent') return { text: JSON.stringify({ intent: 'organize_weekend', confidence: 0.9, entities: [] }), refusal: null, usage: null };
    const reply = h.reply;
    await new Promise<void>((release) => { h.held.push({ schemaName, release }); });
    return { text: reply, refusal: null, usage: null };
  },
};
vi.mock('@/lib/ai/routing', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/routing')>()),
  resolveProviderForTask: async () => provider,
}));

const { answerClarification, submitRequest } = await import('@/lib/ai/runs/intake');
const { claimRun } = await import('@/lib/ai/runs/store');

const PLAN = readFileSync('tests/ai-eval/scripts/organize_weekend.json', 'utf8');
const planReply = (title: string) => {
  const plan = JSON.parse(PLAN).structured.family_plan as Record<string, unknown>;
  return JSON.stringify({
    ...plan,
    steps: [{
      key: 'prep_task', step_type: 'act', tool_name: 'tasks.createTodo', description: title,
      input: JSON.stringify({ title }), depends_on: [], condition: null, approval_required: null, verify: null,
    }],
    clarification: null, answer: null,
  });
};
const answerReply = JSON.stringify({ objective: 'Answer', reasoning_summary: 'Answered from the records.', risk_level: 'low', steps: [], followups: [], clarification: null, answer: 'Soccer is at 10.' });
const questionReply = JSON.stringify({ objective: 'Ask', reasoning_summary: 'Two weekends fit.', risk_level: 'low', steps: [], followups: [], clarification: { question: 'Which weekend?', reason: 'Two fit.' }, answer: null });

let db: InMemorySupabase;
const client = () => db as unknown as SupabaseClient<Database>;
const scope = (): ServiceScope => ({ db: client(), familyId: FAMILY, userId: USER, memberId: PARENT, role: 'parent', actorKind: 'member', tz: 'America/New_York', now: NOW });

/** Wait until a model call is being held, and return it. */
async function heldCall(index: number): Promise<Held> {
  await vi.waitFor(() => { if (!h.held[index]) throw new Error('not yet'); });
  return h.held[index];
}

beforeAll(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterAll(() => { vi.restoreAllMocks(); });

beforeEach(() => {
  db = createInMemorySupabase({
    userId: USER,
    defaults: {
      ai_requests: { status: 'queued', clarifications: [], error: null, started_at: null, completed_at: null, conversation_id: null, kind: 'concierge' },
      family_automation_runs: { attempt: 0, max_attempts: 5, lease_owner: null, lease_expires_at: null, cancel_requested_at: null, paused_at: null, error: null, plan_id: null },
      ai_plan_steps: { retry_count: 0, max_retries: 2, result_json: null, error: null },
    },
  });
  h.client = client();
  h.held = [];
  h.planners = [];
  db.seed('families', [{ id: FAMILY, name: 'The Riveras', timezone: 'America/New_York' }]);
  db.seed('family_members', [{ id: PARENT, family_id: FAMILY, user_id: USER, role: 'parent', is_active: true, display_name: 'Dana' }]);
  db.seed('family_ai_settings', [{ family_id: FAMILY, enabled: true, behavior: 'execute' }]);
});

const runsOf = (requestId: string) => db.table('family_automation_runs').filter((r) => r.request_id === requestId);
const requestRow = (id: string) => db.table('ai_requests').find((r) => r.id === id) as Row;

describe('N3: answering again after a planner timed out', () => {
  beforeEach(() => {
    db.seed('ai_requests', [{
      id: REQUEST, family_id: FAMILY, requested_by: USER, requested_by_member_id: PARENT, kind: 'concierge', request_text: 'Organize our weekend',
      interpreted_intent: 'organize_weekend', status: 'awaiting_context', conversation_id: null, error: null,
      clarifications: [{ question: 'Which weekend?', reason: 'Two fit.', asked_at: '2026-09-01T00:00:00.000Z', answer: null, answered_at: null }],
    }]);
    db.seed('family_automation_runs', [{
      id: RUN, family_id: FAMILY, request_id: REQUEST, plan_id: null, requested_by_member_id: PARENT, run_type: 'concierge',
      state: 'awaiting_context', status: 'pending', summary: 'Which weekend?', attempt: 0, max_attempts: 5,
    }]);
  });

  it('the abandoned planner’s plan never runs; the retry’s plan is the one the person’s run carries', async () => {
    const kicks: string[] = [];
    const kick = (id: string) => { kicks.push(id); };

    // First answer: the model is slow, the budget runs out, the run is parked.
    h.reply = planReply('Pack the picnic (first answer)');
    const first = await answerClarification(scope(), RUN, 'This weekend', { db: client(), kick, plannerBudgetMs: 30 });
    expect(first).toMatchObject({ ok: false, code: 'planner_timeout' });
    const late = await heldCall(0);

    // The person answers again; this planner is thinking too.
    h.reply = planReply('Pack the picnic (second answer)');
    const second = answerClarification(scope(), RUN, 'This weekend, Sunday', { db: client(), kick, plannerBudgetMs: 10_000 });
    const current = await heldCall(1);

    // The first planner finishes while the retry is planning.
    late.release();
    await h.planners[0];
    // Its run was created and cancelled: nothing can claim it.
    const lateRun = runsOf(REQUEST).find((r) => r.id !== RUN);
    expect(lateRun).toMatchObject({ state: 'cancelled' });

    current.release();
    const result = await second;

    expect(result).toMatchObject({ ok: true, data: { runId: RUN, outcome: 'plan' } });
    expect(kicks).toEqual([RUN]);
    // Exactly one runnable run for the request: the person's, with the retry's plan.
    expect(runsOf(REQUEST).filter((r) => r.state === 'ready').map((r) => r.id)).toEqual([RUN]);
    const steps = db.table('ai_plan_steps').filter((s) => s.plan_id === runsOf(REQUEST).find((r) => r.id === RUN)?.plan_id);
    expect(steps.map((s) => s.description)).toEqual(['Pack the picnic (second answer)']);
    expect(requestRow(REQUEST).status).toBe('ready');
  });

  it('a run cancelled while the model was thinking stays cancelled when the planner times out', async () => {
    const { cancelRun } = await import('@/lib/ai/runs/controls');
    h.reply = planReply('Pack the picnic');
    const answering = answerClarification(scope(), RUN, 'This weekend', { db: client(), kick: () => {}, plannerBudgetMs: 200 });
    await heldCall(0);
    expect(await cancelRun(scope(), RUN, { db: client() })).toMatchObject({ ok: true });

    expect(await answering).toMatchObject({ ok: false, code: 'planner_timeout' });

    expect(runsOf(REQUEST).find((r) => r.id === RUN)).toMatchObject({ state: 'cancelled' });
    expect(requestRow(REQUEST).status).toBe('cancelled');
  });
});

describe('N9: a late outcome that is not a plan', () => {
  async function submitAndAbandon(reply: string): Promise<{ requestId: string; held: Held }> {
    h.reply = reply;
    const result = await submitRequest(scope(), { text: 'Organize our weekend' }, { db: client(), kick: () => {}, plannerBudgetMs: 30 });
    expect(result).toMatchObject({ ok: false, code: 'planner_timeout' });
    const requestId = db.table('ai_requests')[0].id as string;
    expect(requestRow(requestId)).toMatchObject({ status: 'failed', error: 'planner_timeout' });
    return { requestId, held: await heldCall(0) };
  }

  it('files no recommendation card and leaves the request failed', async () => {
    db.replace('family_ai_settings', [{ family_id: FAMILY, enabled: true, behavior: 'recommend' }]);
    const { requestId, held } = await submitAndAbandon(planReply('Pack the picnic'));

    held.release();
    await h.planners[0];

    expect(db.table('family_ai_recommendations')).toHaveLength(0);
    expect(requestRow(requestId)).toMatchObject({ status: 'failed' });
  });

  it('leaves the request failed when the late reply was an answer', async () => {
    const { requestId, held } = await submitAndAbandon(answerReply);

    held.release();
    expect(await h.planners[0]).toMatchObject({ ok: false });

    expect(requestRow(requestId)).toMatchObject({ status: 'failed' });
  });

  it('parks nothing when the late reply was a question', async () => {
    const { requestId, held } = await submitAndAbandon(questionReply);

    held.release();
    expect(await h.planners[0]).toMatchObject({ ok: false });

    expect(requestRow(requestId)).toMatchObject({ status: 'failed' });
    expect(requestRow(requestId).clarifications).toEqual([]);
  });

  it('control: a planner inside its budget still files the recommendation and closes the request', async () => {
    db.replace('family_ai_settings', [{ family_id: FAMILY, enabled: true, behavior: 'recommend' }]);
    h.reply = planReply('Pack the picnic');
    const pending = submitRequest(scope(), { text: 'Organize our weekend' }, { db: client(), kick: () => {}, plannerBudgetMs: 10_000 });
    (await heldCall(0)).release();

    const result = await pending;

    expect(result).toMatchObject({ ok: true, data: { outcome: 'recommendation' } });
    expect(db.table('family_ai_recommendations')).toHaveLength(1);
    expect(requestRow(db.table('ai_requests')[0].id as string)).toMatchObject({ status: 'completed' });
  });
});

describe('N3: a late planner’s run, before its fence', () => {
  /** What `claim_ai_runs` does to a due run (0263's candidate predicate), atomically, the moment it runs. */
  function cronClaims(runId: string): boolean {
    const run = db.table('family_automation_runs').find((r) => r.id === runId);
    const now = Date.now();
    const leased = !!run?.lease_expires_at && Date.parse(String(run.lease_expires_at)) >= now;
    if (!run || !['ready', 'scheduled_followup'].includes(String(run.state)) || run.cancel_requested_at || leased
      || Date.parse(String(run.run_after)) > now) return false;
    Object.assign(run, { state: 'executing', attempt: Number(run.attempt) + 1, lease_owner: 'cron-worker', lease_expires_at: new Date(now + 180_000).toISOString() });
    return true;
  }
  /** The cron ticks at the moment the planner has filed its run and before its fence: when the `planned` event lands. */
  function cronTicksBeforeTheFence(): boolean[] {
    const claimed: boolean[] = [];
    const events = db.table('ai_run_events');
    const push = events.push.bind(events);
    events.push = (...rows: Row[]) => {
      for (const row of rows) if (row.event_type === 'planned') claimed.push(cronClaims(String(row.run_id)));
      return push(...rows);
    };
    return claimed;
  }

  it('the abandoned planner’s run is not claimable between its creation and the fence', async () => {
    const claimed = cronTicksBeforeTheFence();
    h.reply = planReply('Pack the picnic');
    const result = await submitRequest(scope(), { text: 'Organize our weekend' }, { db: client(), kick: () => {}, plannerBudgetMs: 30 });
    expect(result).toMatchObject({ ok: false, code: 'planner_timeout' });

    (await heldCall(0)).release();
    expect(await h.planners[0]).toMatchObject({ ok: false });

    // The tick found nothing it could take, and the run is closed with no worker on it.
    expect(claimed).toEqual([false]);
    expect(db.table('family_automation_runs')).toHaveLength(1);
    expect(db.table('family_automation_runs')[0]).toMatchObject({ state: 'cancelled', lease_owner: null });
  });

  it('control: a planner inside its budget hands over a run the queue can take', async () => {
    h.reply = planReply('Pack the picnic');
    const pending = submitRequest(scope(), { text: 'Organize our weekend' }, { db: client(), kick: () => {}, plannerBudgetMs: 10_000 });
    (await heldCall(0)).release();

    expect(await pending).toMatchObject({ ok: true, data: { outcome: 'plan' } });
    const run = db.table('family_automation_runs')[0];
    expect(run).toMatchObject({ state: 'ready', lease_owner: null });
    expect(await claimRun(client(), String(run.id))).toMatchObject({ ok: true, data: { claimed: true } });
  });
});
