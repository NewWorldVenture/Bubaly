// N13 — "Plan our week" checked for conflicts by COUNTING the window's events.
//
// `no_calendar_conflicts` read every event in the window and passed only when
// there was at most one, so any ordinary week (soccer Monday, piano Tuesday)
// failed with "2 events overlap", the verify step failed and the family summary
// waiting on it was blocked. The same read used `ends_at >= start` and never
// expanded a series, so a real clash with a weekly practice — stored once, as
// its series — passed as "Nothing overlaps". And the template's dinner counts
// had no date scope, so last week's dinners satisfied "Dinners are on the
// plan".
//
// The check now asks the calendar's own conflict finder (series expanded,
// one person's overlapping timed events), and the template scopes its dinner
// counts to the week. Driven through the real executor (a verify step and the
// step that waits on it), the real verifier and the real plan_week template,
// over the in-memory database.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

const hoisted = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => hoisted.db, createServer: async () => hoisted.db }));

const { createExecutorPort, runGraphWith } = await import('@/lib/ai/runs/executor');
const { parseVerificationSpec, runVerification } = await import('@/lib/ai/runs/verify');
const { planWeekTemplate } = await import('@/lib/ai/planner/templates/plan-week');
const { instantiateTemplate, templateContextFrom } = await import('@/lib/ai/planner/templates/index');

const FAMILY = '00000000-0000-4000-8000-0000000d1301';
const PARENT = { member: '00000000-0000-4000-8000-0000000d1311', user: '00000000-0000-4000-8000-0000000d1321' };
const MAYA = '00000000-0000-4000-8000-0000000d1312';
const REQUEST = '00000000-0000-4000-8000-0000000d1331';
const PLAN = '00000000-0000-4000-8000-0000000d1332';
const RUN = '00000000-0000-4000-8000-0000000d1333';
const TZ = 'America/New_York';

let db: InMemorySupabase;
const client = () => db as unknown as SupabaseClient<Database>;

function event(id: string, title: string, startsAt: string, endsAt: string | null, over: Row = {}): Row {
  return {
    id, family_id: FAMILY, title, starts_at: startsAt, ends_at: endsAt, all_day: false, category: 'sports', location: null,
    assignee_id: MAYA, description: null, created_by: PARENT.user, recurrence: 'none', recurrence_until: null, feed_id: null,
    external_uid: null, source_recurrence: null, onboarding_key: null, idempotency_key: null, ...over,
  };
}

beforeEach(() => {
  db = createInMemorySupabase({
    uniques: { ai_tool_calls: [['family_id', 'idempotency_key']] },
    defaults: {
      ai_tool_calls: { state: 'reserved', attempt: 1, outputs: null, error: null, finished_at: null },
      todo_items: { is_done: false, priority: 'medium', tags: [], sort_order: 0, completed_at: null, due_date: null, notes: null, assigned_to_id: null },
      todo_lists: { is_archived: false },
    },
  });
  hoisted.db = db;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db.seed('families', [{ id: FAMILY, name: 'The Riveras', timezone: TZ }]);
  db.seed('family_members', [
    { id: PARENT.member, family_id: FAMILY, user_id: PARENT.user, role: 'parent', is_active: true, display_name: 'Dana' },
    { id: MAYA, family_id: FAMILY, user_id: null, role: 'child', is_active: true, display_name: 'Maya' },
  ]);
  db.seed('family_ai_settings', [{ family_id: FAMILY, enabled: true, behavior: 'execute' }]);
  db.seed('ai_requests', [{ id: REQUEST, family_id: FAMILY, requested_by: PARENT.user, requested_by_member_id: PARENT.member, kind: 'concierge', request_text: 'Plan our week', status: 'executing' }]);
  db.seed('ai_plans', [{ id: PLAN, family_id: FAMILY, request_id: REQUEST, version: 1, status: 'approved', risk_level: 'low' }]);
  const base = { family_id: FAMILY, plan_id: PLAN, condition: null, approval_required: false, approval_id: null, risk_level: 'low', retry_count: 0, max_retries: 0, result_json: null, error: null };
  db.seed('ai_plan_steps', [
    {
      ...base, id: 'check-week', sequence: 0, step_type: 'verify', tool_name: null, description: 'Check the week really is planned', dependency_ids: [], status: 'queued',
      input_json: { checks: [{ kind: 'no_calendar_conflicts', start: '2026-09-14T00:00:00', end: '2026-09-20T23:59:00', label: 'Nothing overlaps this week' }] },
    },
    {
      ...base, id: 'after-check', sequence: 1, step_type: 'act', tool_name: 'tasks.createTodo', description: 'Pin the week up', dependency_ids: ['check-week'], status: 'queued',
      input_json: { title: 'The week is planned' },
    },
  ]);
  db.seed('family_automation_runs', [{
    id: RUN, family_id: FAMILY, plan_id: PLAN, request_id: REQUEST, run_type: 'concierge', state: 'ready', status: 'pending',
    requested_by_member_id: PARENT.member, attempt: 1, max_attempts: 5, lease_owner: 'worker-1', lease_expires_at: '2099-01-01T00:00:00Z',
    cancel_requested_at: null, paused_at: null, progress: {}, created_by: PARENT.user,
  }]);
});

const step = (id: string) => db.table('ai_plan_steps').find((s) => s.id === id) as Row;
const runWeek = () => runGraphWith(createExecutorPort(client()), RUN, { budgetMs: 60_000 });

describe('the week’s conflict check', () => {
  it('passes a week of events that do not overlap, so the step after it runs', async () => {
    db.seed('calendar_events', [
      event('00000000-0000-4000-8000-0000000d1400', 'Soccer', '2026-09-14T20:00:00Z', '2026-09-14T21:00:00Z'),
      event('00000000-0000-4000-8000-0000000d1401', 'Piano', '2026-09-15T20:00:00Z', '2026-09-15T21:00:00Z'),
      event('00000000-0000-4000-8000-0000000d1402', 'Grandma’s dinner', '2026-09-17T22:00:00Z', '2026-09-17T23:30:00Z', { assignee_id: PARENT.member }),
    ]);

    const result = await runWeek();

    expect(step('check-week')).toMatchObject({ status: 'completed' });
    expect(step('after-check')).toMatchObject({ status: 'completed' });
    expect(result.status).toBe('completed');
  });

  it('fails on a real clash with a weekly practice stored as its series, and says what it found', async () => {
    db.seed('calendar_events', [
      // Every Wednesday 4:00–5:30 pm, from the start of the month.
      event('00000000-0000-4000-8000-0000000d1403', 'Practice', '2026-09-02T20:00:00Z', '2026-09-02T21:30:00Z', { recurrence: 'weekly' }),
      event('00000000-0000-4000-8000-0000000d1404', 'Dentist', '2026-09-16T20:30:00Z', '2026-09-16T21:00:00Z', { category: 'medical' }),
    ]);

    await runWeek();

    expect(step('check-week')).toMatchObject({ status: 'failed' });
    expect(String(step('check-week').error)).toMatch(/double-booking/);
    expect(step('after-check')).toMatchObject({ status: 'blocked' });
  });
});

describe('the plan_week template’s dinner count', () => {
  const scope = (): ServiceScope => ({ db: client(), familyId: FAMILY, userId: PARENT.user, memberId: PARENT.member, role: 'parent', actorKind: 'ai', tz: TZ });
  const weekCheck = () => {
    // Asked on Friday 11 September: the week is the coming Monday onward.
    const ctx = templateContextFrom({ tz: TZ, nowIso: '2026-09-11T15:00:00Z', todayKey: '2026-09-11', requestText: 'Plan our week' });
    const plan = instantiateTemplate(planWeekTemplate, ctx);
    const spec = parseVerificationSpec(JSON.parse(plan.steps.find((s) => s.key === 'check_week')!.input));
    if (!spec.ok) throw new Error(spec.error);
    return { ...spec.data, checks: spec.data.checks.filter((c) => c.kind === 'count_at_least') };
  };

  it('is not satisfied by last week’s dinners', async () => {
    db.seed('meal_plans', ['2026-09-07', '2026-09-08', '2026-09-09'].map((day, i) => ({ id: `mp-${i}`, family_id: FAMILY, plan_date: day, meal_type: 'dinner' })));

    const outcome = await runVerification(scope(), weekCheck());

    expect(outcome).toMatchObject({ ok: true, data: { verified: false } });
  });

  it('control: is satisfied by the week’s own dinners', async () => {
    db.seed('meal_plans', ['2026-09-14', '2026-09-15', '2026-09-16'].map((day, i) => ({ id: `mp-${i}`, family_id: FAMILY, plan_date: day, meal_type: 'dinner' })));

    const outcome = await runVerification(scope(), weekCheck());

    expect(outcome).toMatchObject({ ok: true, data: { verified: true } });
  });
});
