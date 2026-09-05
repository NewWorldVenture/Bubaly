// The whole AI loop, end to end, with the scripted provider (map §5 Phase 2).
//
// "Plan our week" goes in through `submitRequest` — the same function the
// POST /api/ai/requests route and the Ask Bubaly server action call — and the
// test then does what the route's `after()` does: claims the run and executes
// it with `continueRun`. Nothing between the request text and the household
// rows is mocked: the intent classifier's fast path, the context builder over
// the domain services, the planner through `structured()` and the validator,
// the store, the executor's DB port, `executeTool` with its trust gate and
// ledger, the meals/groceries/tasks/reminders/notifications services, and the
// run detail read the run page performs. Only two things are substituted:
//
//   - the model, which is the `AI_PROVIDER_STUB=1` scripted provider reading
//     tests/ai-eval/scripts/plan_week.json — exactly what CI and the
//     Playwright spec use;
//   - Postgres, which is the in-memory PostgREST stand-in in
//     tests/helpers/in-memory-supabase.ts, so the tables written by one module
//     are the tables read by the next.
//
// What this proves that the per-module tests cannot: the ids line up. The
// request the intake files is the request the planner marks ready; the plan
// the planner saves is the plan whose steps the executor loads; the run the
// planner creates is the run `claimRun` leases; the tool calls the executor
// makes reach the services and leave household rows (meal plans, grocery
// items, a to-do, a reminder, notifications) under the same family; and a
// fresh `loadRunDetail` — the refresh-equivalent — shows the finished run with
// its steps and timeline.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY = '00000000-0000-4000-8000-00000000fa01';
const USER = '00000000-0000-4000-8000-0000000000a1';
const PARENT = '00000000-0000-4000-8000-00000000me01';
const CHILD = '00000000-0000-4000-8000-00000000me02';

// The scripted plan is written against the week of 2026-09-14; the household's
// clock is pinned just before it so the plan is always "next week".
const NOW = new Date('2026-09-05T15:00:00Z');

const db: InMemorySupabase = createInMemorySupabase({
  userId: USER,
  uniques: {
    // The two constraints the loop's idempotency relies on (0250).
    ai_tool_calls: [['family_id', 'idempotency_key']],
    family_automation_runs: [['family_id', 'idempotency_key']],
  },
  // The column defaults from 0250/0251 that the loop's guards read back —
  // `claimRun` refuses a run whose `attempt` is not below `max_attempts`, the
  // executor's retry ceiling is `max_retries`, and the approval reconciler
  // reads `plan_step_ids`.
  defaults: {
    ai_requests: { kind: 'concierge', request_text: '', status: 'queued', priority: 0, context_stats: {}, clarifications: [], error: null, completed_at: null, started_at: null, interpreted_intent: null, intent_confidence: null, conversation_id: null },
    ai_plans: { version: 1, status: 'draft', risk_level: 'low', estimated_actions: 0, requires_approval: false },
    ai_plan_steps: { sequence: 0, step_type: 'act', input_json: {}, dependency_ids: [], status: 'queued', approval_required: false, approval_id: null, risk_level: 'low', retry_count: 0, max_retries: 2, result_json: null, error: null, condition: null, started_at: null, completed_at: null },
    family_automation_runs: { run_type: 'concierge_plan', state: 'queued', status: 'queued', progress: {}, attempt: 0, max_attempts: 5, lease_owner: null, lease_expires_at: null, cancel_requested_at: null, paused_at: null, started_at: null, completed_at: null, error: null, summary: null, plan_id: null, request_id: null },
    ai_run_events: { message: '', payload: {}, actor_kind: 'ai' },
    ai_tool_calls: { actor_kind: 'ai', inputs: {}, state: 'reserved', attempt: 1, outputs: null, error: null, finished_at: null },
    approval_requests: { status: 'pending', plan_step_ids: [], consequences: [], edited_payload: null, payload_kind: null },
    // The household tables the scripted plan writes to (0001): the tools
    // validate what the services return, and a column the migration defaults
    // (`todos.is_done`) must come back the way Postgres would return it.
    todo_items: { is_done: false, priority: 'medium', tags: [], sort_order: 0, completed_at: null, due_date: null, notes: null, assigned_to_id: null },
    todo_lists: { is_archived: false },
    family_reminders: { is_done: false, snoozed_until: null, notes: null, recurrence: 'none' },
    meals: { meal_type: 'dinner', ingredients: [], notes: null },
    meal_plans: { meal_type: 'dinner', notes: null },
    grocery_items: { is_checked: false, quantity: null, category: null, source_meal_id: null },
    grocery_lists: { name: 'Groceries', is_archived: false },
    notifications: { is_read: false, body: null, link: null },
  },
});
const client = db as unknown as SupabaseClient<Database>;

// The executor, the continuation and the intake resolve the service client
// themselves; every one of them must land on the same in-memory tables.
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => client,
  createServer: async () => client,
}));

process.env.AI_PROVIDER_STUB = '1';
delete process.env.VERCEL_ENV;

function scope(): ServiceScope {
  return {
    db: client,
    familyId: FAMILY,
    userId: USER,
    memberId: PARENT,
    role: 'parent',
    actorKind: 'member',
    tz: 'America/New_York',
    now: NOW,
  };
}

beforeAll(() => {
  db.seed('families', [{ id: FAMILY, name: 'The Hughens', timezone: 'America/New_York', created_by: USER }]);
  db.seed('family_members', [
    { id: PARENT, family_id: FAMILY, user_id: USER, display_name: 'Dan', role: 'parent', is_active: true, birthdate: null },
    { id: CHILD, family_id: FAMILY, user_id: null, display_name: 'Maya', role: 'child', is_active: true, birthdate: '2016-03-02' },
  ]);
  db.seed('calendar_events', [{
    family_id: FAMILY, title: 'Soccer practice', starts_at: '2026-09-16T20:00:00Z', ends_at: '2026-09-16T21:30:00Z',
    all_day: false, category: 'sports', location: null, assignee_id: CHILD, description: null, created_by: USER,
  }]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => { vi.restoreAllMocks(); });

describe('Ask Bubaly → plan → run → household rows → run page (scripted provider)', () => {
  let requestId = '';
  let runId = '';
  let planId = '';
  const kicks: { runId: string; budgetMs: number }[] = [];

  it('files the request and answers with a persisted plan before any execution', async () => {
    const { submitRequest } = await import('@/lib/ai/runs/intake');
    const result = await submitRequest(scope(), { text: 'Plan our week' }, {
      db: client,
      kick: (id, opts) => { kicks.push({ runId: id, budgetMs: opts.budgetMs }); },
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.outcome).toBe('plan');
    expect(result.data.runId).toBeTruthy();
    expect(result.data.planId).toBeTruthy();
    expect(result.data.redirect).toBe(`/dashboard/concierge/runs/${result.data.runId}`);
    requestId = result.data.requestId;
    runId = result.data.runId as string;
    planId = result.data.planId as string;

    // The continuation was scheduled with an explicit budget, and nothing ran yet.
    expect(kicks).toEqual([{ runId, budgetMs: expect.any(Number) }]);
    expect(db.table('ai_tool_calls')).toHaveLength(0);

    // ai_requests → ai_plans → ai_plan_steps → run: every row under the family,
    // every link pointing at the row the previous stage wrote.
    const request = db.table('ai_requests').find((r) => r.id === requestId);
    expect(request).toMatchObject({ family_id: FAMILY, requested_by: USER, interpreted_intent: 'plan_week', status: 'ready', request_text: 'Plan our week' });
    const plan = db.table('ai_plans').find((p) => p.id === planId);
    expect(plan).toMatchObject({ family_id: FAMILY, request_id: requestId, version: 1, status: 'approved', planner_model: 'scripted-stub' });
    const steps = db.table('ai_plan_steps').filter((s) => s.plan_id === planId);
    expect(steps.length).toBeGreaterThanOrEqual(9);
    expect(steps.every((s) => s.family_id === FAMILY && s.status === 'queued')).toBe(true);
    expect(steps.map((s) => s.tool_name)).toEqual(expect.arrayContaining([
      'calendar.searchEvents', 'calendar.findConflicts', 'tasks.searchTodos', 'meals.getMealPlan',
      'meals.planWeek', 'groceries.addFromMealPlan', 'tasks.createTodo', 'reminders.create',
    ]));
    // Dependencies were rewritten from the model's keys to the persisted step ids.
    const stepIds = new Set(steps.map((s) => s.id));
    for (const step of steps) for (const dep of step.dependency_ids as string[]) expect(stepIds.has(dep)).toBe(true);

    const run = db.table('family_automation_runs').find((r) => r.id === runId);
    expect(run).toMatchObject({ family_id: FAMILY, request_id: requestId, plan_id: planId, state: 'ready', requested_by_member_id: PARENT, run_type: 'concierge' });
    expect(db.table('ai_run_events').filter((e) => e.run_id === runId).map((e) => e.event_type)).toContain('planned');
    // The request's context snapshot was persisted for the audit trail.
    expect(db.table('ai_request_context').some((c) => c.request_id === requestId)).toBe(true);
  });

  it('executes the run through the real executor, tools and services, and parks at the follow-up', async () => {
    const { continueRun } = await import('@/lib/ai/runs/continue');
    const result = await continueRun(runId, { budgetMs: 60_000, db: client });
    expect(result.claimed).toBe(true);
    expect(result.failed).toBe(0);

    // The scripted plan ends with a "3d" follow-up. Every step before it ran,
    // the follow-up itself scheduled the continuation, and the run is parked
    // at `scheduled_followup` with `run_after` three days out — the honest
    // state for "the week is planned; Bubaly checks back mid-week" (§10).
    const run = db.table('family_automation_runs').find((r) => r.id === runId);
    expect(run).toMatchObject({ state: 'scheduled_followup', lease_owner: null, run_after: '2026-09-08T15:00:00.000Z', error: null });
    expect(run?.progress).toMatchObject({ total: 12, completed: 11, failed: 0, blocked: 0, pending: 1 });
    expect(db.table('ai_requests').find((r) => r.id === requestId)).toMatchObject({ status: 'scheduled_followup' });

    const steps = db.table('ai_plan_steps').filter((s) => s.plan_id === planId);
    const pending = steps.filter((s) => s.status !== 'completed');
    expect(pending).toHaveLength(1);
    // The one step left is the notify the validator attached to the follow-up
    // ("Remind the parents"), which by construction waits for the follow-up.
    expect(pending[0]).toMatchObject({ step_type: 'notify', status: 'queued' });
    expect(steps.filter((s) => s.tool_name)).toHaveLength(8);
    expect(steps.filter((s) => s.tool_name).every((s) => s.status === 'completed')).toBe(true);
    expect(steps.find((s) => s.step_type === 'verify')).toMatchObject({ status: 'completed' });

    // Every WRITE went through the ledger under this family and the run — one
    // row per act tool, each closed as succeeded, each under its own
    // idempotency key. Reads are deliberately not ledgered (`executeTool`
    // skips the reservation for read-only tools), so four rows is exact.
    const ledger = db.table('ai_tool_calls');
    expect(ledger).toHaveLength(4);
    expect(ledger.every((c) => c.family_id === FAMILY && c.run_id === runId && c.state === 'succeeded')).toBe(true);
    expect(new Set(ledger.map((c) => c.idempotency_key)).size).toBe(ledger.length);
    expect(ledger.map((c) => c.tool_name).sort()).toEqual(['groceries.addFromMealPlan', 'meals.planWeek', 'reminders.create', 'tasks.createTodo']);
    expect(ledger.every((c) => typeof c.plan_step_id === 'string' && c.request_id === requestId)).toBe(true);

    // …and left household rows behind: three dinners, their groceries, the
    // to-do for Maya, the reminder, and the family notification.
    const mealPlans = db.table('meal_plans').filter((m) => m.family_id === FAMILY);
    expect(mealPlans.map((m) => m.plan_date).sort()).toEqual(['2026-09-14', '2026-09-15', '2026-09-16']);
    expect(db.table('meals').filter((m) => m.family_id === FAMILY).map((m) => m.name).sort()).toEqual(['Pasta with pesto', 'Sheet-pan chicken and veg', 'Taco night']);
    const groceries = db.table('grocery_items').filter((g) => g.family_id === FAMILY);
    expect(groceries.map((g) => String(g.name).toLowerCase())).toEqual(expect.arrayContaining(['chicken thighs', 'broccoli', 'tortillas', 'ground beef', 'pasta', 'pesto']));
    const todo = db.table('todo_items').find((t) => t.family_id === FAMILY);
    expect(todo).toMatchObject({ title: 'Pack the soccer kit for practice', assigned_to_id: CHILD, due_date: '2026-09-15', is_done: false });
    expect(db.table('family_reminders').find((r) => r.family_id === FAMILY)).toMatchObject({ title: 'Early pickup Thursday at 2:30' });
    const notifications = db.table('notifications').filter((n) => n.family_id === FAMILY);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ title: 'Your week of Sep 14 is planned', type: 'system' });

    // The timeline tells the story in order.
    const events = db.table('ai_run_events').filter((e) => e.run_id === runId).map((e) => e.event_type);
    expect(events[0]).toBe('planned');
    expect(events[1]).toBe('run_started');
    expect(events.filter((e) => e === 'step_completed').length).toBe(8);
    expect(events).toContain('verified');
    expect(events).toContain('notified');
    expect(events[events.length - 1]).toBe('followup_scheduled');
    expect(events).not.toContain('step_failed');
  });

  it('refuses to run the follow-up before it is due: a second continuation claims nothing', async () => {
    const { continueRun } = await import('@/lib/ai/runs/continue');
    const before = db.table('ai_tool_calls').length;
    const again = await continueRun(runId, { budgetMs: 60_000, db: client });
    expect(again.claimed).toBe(false);
    expect(again.status).toBe('scheduled_followup');
    expect(db.table('ai_tool_calls')).toHaveLength(before);
    expect(db.table('meal_plans').filter((m) => m.family_id === FAMILY)).toHaveLength(3);
    expect(db.table('notifications').filter((n) => n.family_id === FAMILY)).toHaveLength(1);
  });

  it('finishes the run when the follow-up comes due, without repeating any earlier step', async () => {
    // What the cron's `run_after <= now()` sees three days later.
    const run = db.table('family_automation_runs').find((r) => r.id === runId);
    if (run) run.run_after = new Date(Date.now() - 1_000).toISOString();

    const { continueRun } = await import('@/lib/ai/runs/continue');
    const before = db.table('ai_tool_calls').length;
    const result = await continueRun(runId, { budgetMs: 60_000, db: client });
    expect(result.claimed).toBe(true);
    expect(result.status).toBe('completed');

    expect(db.table('family_automation_runs').find((r) => r.id === runId)).toMatchObject({ state: 'completed', lease_owner: null, error: null });
    expect(db.table('ai_requests').find((r) => r.id === requestId)).toMatchObject({ status: 'completed' });
    expect(db.table('ai_plan_steps').filter((s) => s.plan_id === planId).every((s) => s.status === 'completed')).toBe(true);
    // No tool ran again — the four earlier writes are the whole ledger — and
    // the only new household row is the mid-week reminder to the parents.
    expect(db.table('ai_tool_calls')).toHaveLength(before);
    expect(db.table('meal_plans').filter((m) => m.family_id === FAMILY)).toHaveLength(3);
    const notifications = db.table('notifications').filter((n) => n.family_id === FAMILY);
    expect(notifications).toHaveLength(2);
    expect(notifications[1]).toMatchObject({ title: 'Bubaly follow-up', user_id: USER });
    const events = db.table('ai_run_events').filter((e) => e.run_id === runId).map((e) => e.event_type);
    expect(events[events.length - 1]).toBe('run_completed');

    // A completed run is never picked up again.
    const once = await continueRun(runId, { budgetMs: 60_000, db: client });
    expect(once.claimed).toBe(false);
    expect(once.status).toBe('completed');
  });

  it('is still there on a refresh: loadRunDetail shows the finished run, its steps and events', async () => {
    const { loadRunDetail } = await import('@/lib/ai/runs/detail');
    const detail = await loadRunDetail(client, FAMILY, runId, { viewerRole: 'parent' });
    expect(detail.ok).toBe(true);
    if (!detail.ok || !detail.data) return;
    expect(detail.data.run.state).toBe('completed');
    expect(detail.data.request?.request_text).toBe('Plan our week');
    expect(detail.data.plan?.id).toBe(planId);
    expect(detail.data.plan?.reasoning_summary).toContain('planned dinners');
    expect(detail.data.steps).toHaveLength(12);
    expect(detail.data.steps.every((s) => s.status === 'completed')).toBe(true);
    // Steps come back in plan order, so the page's timeline reads top to bottom.
    expect(detail.data.steps.map((s) => s.sequence)).toEqual([...Array(12).keys()]);
    const eventTypes = detail.data.events.map((e) => e.event_type);
    expect(eventTypes[0]).toBe('planned');
    expect(eventTypes).toContain('run_completed');
    expect(detail.data.approvals).toEqual([]);

    // Another family's read sees nothing — a 404 on the route, never a 403.
    const foreign = await loadRunDetail(client, '00000000-0000-4000-8000-00000000fa02', runId);
    expect(foreign.ok).toBe(true);
    if (foreign.ok) expect(foreign.data).toBeNull();
  });
});
