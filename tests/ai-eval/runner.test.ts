// The eval harness (spec §45–§47): every scenario in ./scenarios driven
// through the REAL loop — intake, classifier, context builder, planner,
// validator, store, executor, tool gate and services — against the in-memory
// Postgres, with the scripted provider standing in for the model.
//
// What this catches that the per-scenario tests cannot: a change that quietly
// widens what a workflow may touch. Each scenario names the tools it must use
// AND the tools it must never use, the household rows it must leave AND the
// tables it must not write. A planner that starts reaching for
// `finances.createTransaction` in "plan our week", or a validator that stops
// dropping off-catalogue steps, fails here rather than in somebody's kitchen.
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, type InMemorySupabase } from '../helpers/in-memory-supabase';

type Scenario = {
  id: string;
  prompt: string;
  intent: string;
  outcome: 'plan' | 'answer' | 'clarification';
  requiredTools: string[];
  prohibitedTools: string[];
  expectRecords: Record<string, number>;
  expectNoRecords: string[];
  expectApproval: boolean;
  finalStates: string[];
  note: string;
};

const DIR = resolve('tests/ai-eval/scenarios');
const SCENARIOS: Scenario[] = readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(resolve(DIR, f), 'utf8')) as Scenario)
  .sort((a, b) => a.id.localeCompare(b.id));

const FAMILY = '00000000-0000-4000-8000-00000000fa01';
const USER = '00000000-0000-4000-8000-0000000000a1';
const PARENT = '00000000-0000-4000-8000-00000000me01';
const CHILD = '00000000-0000-4000-8000-00000000me02';
const ADULT = '00000000-0000-4000-8000-00000000me03';
const ADULT_USER = '00000000-0000-4000-8000-0000000000a2';
/** The trip the vacation scenario prepares for. Fixed, because a scripted plan
 *  carries its `vacation_id` literally — the executor passes `input_json`
 *  through verbatim, which is exactly why a real plan reads the id from the
 *  context rather than from an earlier step's output. */
const TRIP = '00000000-0000-4000-8000-00000000ab01';
const NOW = new Date('2026-09-05T15:00:00Z');

const db: InMemorySupabase = createInMemorySupabase({
  userId: USER,
  uniques: {
    ai_tool_calls: [['family_id', 'idempotency_key']],
    family_automation_runs: [['family_id', 'idempotency_key']],
  },
  defaults: {
    ai_requests: { kind: 'concierge', request_text: '', status: 'queued', priority: 0, context_stats: {}, clarifications: [], error: null, completed_at: null, started_at: null, interpreted_intent: null, intent_confidence: null, conversation_id: null },
    ai_plans: { version: 1, status: 'draft', risk_level: 'low', estimated_actions: 0, requires_approval: false },
    ai_plan_steps: { sequence: 0, step_type: 'act', input_json: {}, dependency_ids: [], status: 'queued', approval_required: false, approval_id: null, risk_level: 'low', retry_count: 0, max_retries: 2, result_json: null, error: null, condition: null, started_at: null, completed_at: null },
    family_automation_runs: { run_type: 'concierge_plan', state: 'queued', status: 'queued', progress: {}, attempt: 0, max_attempts: 5, lease_owner: null, lease_expires_at: null, cancel_requested_at: null, paused_at: null, started_at: null, completed_at: null, error: null, summary: null, plan_id: null, request_id: null },
    ai_run_events: { message: '', payload: {}, actor_kind: 'ai' },
    ai_tool_calls: { actor_kind: 'ai', inputs: {}, state: 'reserved', attempt: 1, outputs: null, error: null, finished_at: null },
    approval_requests: { status: 'pending', plan_step_ids: [], consequences: [], edited_payload: null, payload_kind: null },
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

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => client,
  createServer: async () => client,
}));

process.env.AI_PROVIDER_STUB = '1';
delete process.env.VERCEL_ENV;

function scope(): ServiceScope {
  return {
    db: client, familyId: FAMILY, userId: USER, memberId: PARENT, role: 'parent',
    actorKind: 'member', tz: 'America/New_York', now: NOW,
  };
}

/** The household every scenario starts from: two people, one commitment, one month of spending. */
function seedHousehold() {
  db.reset();
  db.seed('families', [{ id: FAMILY, name: 'The Hughens', timezone: 'America/New_York', created_by: USER }]);
  // Dan, Maya and Dana: the three people the scripted plans assign work to. A
  // name the household does not have fails the step by design
  // (`resolveAssigneeId`), so the harness must seed everyone the scripts name.
  db.seed('family_members', [
    { id: PARENT, family_id: FAMILY, user_id: USER, display_name: 'Dan', role: 'parent', is_active: true, birthdate: null },
    { id: CHILD, family_id: FAMILY, user_id: null, display_name: 'Maya', role: 'child', is_active: true, birthdate: '2016-03-02' },
    // Dana has a login and Maya does not — which is the real household shape,
    // and the reason a "tell everyone" run reports one person told and one
    // managed profile skipped rather than pretending it reached a child's phone.
    { id: ADULT, family_id: FAMILY, user_id: ADULT_USER, display_name: 'Dana', role: 'adult', is_active: true, birthdate: null },
  ]);
  db.seed('calendar_events', [{
    family_id: FAMILY, title: 'Soccer practice', starts_at: '2026-09-16T20:00:00Z', ends_at: '2026-09-16T21:30:00Z',
    all_day: false, category: 'sports', location: null, assignee_id: CHILD, description: null, created_by: USER,
  }]);
  // A trip already on file, with its travellers: "prepare for our trip" is
  // asked about a trip the family has, not one Bubaly invents.
  db.seed('vacations', [{
    id: TRIP, family_id: FAMILY, title: 'Autumn half-term in Lisbon', destination: 'Lisbon',
    kind: 'leisure', status: 'planning', start_date: '2026-10-24', end_date: '2026-10-31',
    timezone: 'Europe/Lisbon', is_international: true, currency: 'USD', budget_cents: 250000,
    cover_image_url: null, description: null, notes: null, created_by: USER,
  }]);
  db.seed('vacation_members', [
    { vacation_id: TRIP, family_id: FAMILY, member_id: PARENT, role: 'traveler' },
    { vacation_id: TRIP, family_id: FAMILY, member_id: CHILD, role: 'traveler' },
  ]);
  // Maya's passport expires inside six months of departure — the risk the
  // vacation workflow is supposed to catch and turn into a task.
  db.seed('vacation_documents', [{
    vacation_id: TRIP, family_id: FAMILY, member_id: CHILD, kind: 'passport',
    label: "Maya's passport", expires_on: '2027-01-15', document_id: null, notes: null,
  }]);
  // A plumber the family used before, so "find a plumber" has a real answer.
  db.seed('home_contractors', [{
    family_id: FAMILY, name: 'Reliable Plumbing', trade: 'plumber', company: 'Reliable Plumbing Ltd',
    phone: '555-0100', email: null, website: null, rating: 5, is_preferred: true, notes: null, created_by: USER,
  }]);
}

beforeAll(() => { if (!process.env.EVAL_DEBUG) vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterAll(() => { vi.restoreAllMocks(); });
beforeEach(() => { seedHousehold(); });

describe('AI eval scenarios', () => {
  it('has a scenario for every scripted prompt the provider answers', () => {
    // A script with no scenario is a workflow nobody checks.
    const scripts = readdirSync(resolve('tests/ai-eval/scripts')).filter((f) => f.endsWith('.json'));
    expect(SCENARIOS.length).toBe(scripts.length);
  });

  it.each(SCENARIOS.map((s) => [s.id, s] as const))('%s', async (_id, scenario) => {
    const { submitRequest } = await import('@/lib/ai/runs/intake');
    const { continueRun } = await import('@/lib/ai/runs/continue');

    // The baseline the household starts from: "must not write X" means no NEW
    // rows, not "the table is empty" — the seed itself has a calendar event.
    const before = Object.fromEntries(
      [...scenario.expectNoRecords, ...Object.keys(scenario.expectRecords)]
        .map((table) => [table, db.table(table).filter((r) => r.family_id === FAMILY).length]),
    );

    const result = await submitRequest(scope(), { text: scenario.prompt }, { db: client, kick: () => {}, now: NOW });
    expect(result.ok, `${scenario.id}: ${result.ok ? '' : result.error}`).toBe(true);
    if (!result.ok) return;

    expect(result.data.outcome, scenario.note).toBe(scenario.outcome);
    const request = db.table('ai_requests').find((r) => r.id === result.data.requestId);
    expect(request?.interpreted_intent).toBe(scenario.intent);

    if (scenario.outcome === 'plan') {
      const planId = result.data.planId as string;
      const steps = db.table('ai_plan_steps').filter((s) => s.plan_id === planId);
      const tools = steps.map((s) => s.tool_name).filter(Boolean) as string[];
      for (const tool of scenario.requiredTools) expect(tools, `${scenario.id} must use ${tool}; the plan kept: ${tools.join(', ')}`).toContain(tool);
      for (const tool of scenario.prohibitedTools) expect(tools, `${scenario.id} must never use ${tool}`).not.toContain(tool);

      const runId = result.data.runId as string;
      await continueRun(runId, { budgetMs: 60_000, db: client });
      const run = db.table('family_automation_runs').find((r) => r.id === runId);
      const failed = db.table('ai_plan_steps')
        .filter((s) => s.plan_id === planId && s.status !== 'completed')
        .map((s) => `${String(s.tool_name ?? s.step_type)}: ${String(s.status)}${s.error ? ` — ${String(s.error)}` : ''}`);
      expect(scenario.finalStates, `${scenario.id} settled in ${String(run?.state)}; unfinished: ${failed.join(' | ')}`).toContain(String(run?.state));

      const pending = db.table('approval_requests').filter((a) => a.family_id === FAMILY && a.status === 'pending');
      expect(pending.length > 0, `${scenario.id} approval expectation`).toBe(scenario.expectApproval);
    } else {
      // An answer is an answer: no plan, no run, nothing executed.
      expect(result.data.planId).toBeNull();
      expect(db.table('ai_tool_calls')).toHaveLength(0);
    }

    for (const [table, min] of Object.entries(scenario.expectRecords)) {
      const added = db.table(table).filter((r) => r.family_id === FAMILY).length - (before[table] ?? 0);
      expect(added, `${scenario.id} expected ≥${min} new ${table}`).toBeGreaterThanOrEqual(min);
    }
    for (const table of scenario.expectNoRecords) {
      const added = db.table(table).filter((r) => r.family_id === FAMILY).length - (before[table] ?? 0);
      expect(added, `${scenario.id} must not write ${table}`).toBe(0);
    }
  });
});
