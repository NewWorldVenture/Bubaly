// The executor keyed every tool call by its STEP, so a retried step was
// deduplicated but two steps of one plan that create the identical thing were
// two keys, two reservations and two rows: two "Pack the soccer kit" to-dos.
// The run now keys a call by what it does — household, run, tool and the full
// arguments (`runActionKey`) — so the second step replays the first's result.
// Different arguments (another assignee, another title) stay separate writes.
//
// Driven through the real executor, `executeTool`, its ledger and the tasks
// service, over the in-memory database.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const hoisted = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => hoisted.db }));

const { createExecutorPort, runGraphWith } = await import('@/lib/ai/runs/executor');

const FAMILY = '00000000-0000-4000-8000-0000000e0e01';
const PARENT = { member: '00000000-0000-4000-8000-0000000e1e01', user: '00000000-0000-4000-8000-0000000e2e01' };
const CHILD = '00000000-0000-4000-8000-0000000e1e02';
const SIBLING = '00000000-0000-4000-8000-0000000e1e03';
const REQUEST = '00000000-0000-4000-8000-0000000e3e01';
const PLAN = '00000000-0000-4000-8000-0000000e3e02';
const RUN = '00000000-0000-4000-8000-0000000e3e03';

let db: InMemorySupabase;

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
  db.seed('families', [{ id: FAMILY, name: 'The Riveras', timezone: 'America/New_York' }]);
  db.seed('family_members', [
    { id: PARENT.member, family_id: FAMILY, user_id: PARENT.user, role: 'parent', is_active: true, display_name: 'Dana' },
    { id: CHILD, family_id: FAMILY, user_id: null, role: 'child', is_active: true, display_name: 'Maya' },
    { id: SIBLING, family_id: FAMILY, user_id: null, role: 'child', is_active: true, display_name: 'Leo' },
  ]);
  db.seed('ai_requests', [{ id: REQUEST, family_id: FAMILY, requested_by: PARENT.user, requested_by_member_id: PARENT.member, kind: 'concierge', request_text: 'Get the kids ready for soccer', status: 'ready' }]);
  db.seed('ai_plans', [{ id: PLAN, family_id: FAMILY, request_id: REQUEST, version: 1, status: 'approved', risk_level: 'low' }]);
  const todo = (id: string, input: Record<string, unknown>, after: string[]) => ({
    id, family_id: FAMILY, plan_id: PLAN, sequence: Number(id.slice(-1)), step_type: 'act', tool_name: 'tasks.createTodo', description: id,
    input_json: input, dependency_ids: after, condition: null, status: 'queued', approval_required: false, approval_id: null,
    risk_level: 'low', retry_count: 0, max_retries: 0, result_json: null, error: null,
  });
  db.seed('ai_plan_steps', [
    todo('step-1', { title: 'Pack the soccer kit', assignee_id: CHILD }, []),
    // The same to-do again — the duplicate a planner actually produces.
    todo('step-2', { assignee_id: CHILD, title: 'Pack the soccer kit' }, ['step-1']),
    // The same title for someone else is a different to-do and must stay one.
    todo('step-3', { title: 'Pack the soccer kit', assignee_id: SIBLING }, ['step-2']),
  ]);
  db.seed('family_automation_runs', [{
    id: RUN, family_id: FAMILY, plan_id: PLAN, request_id: REQUEST, run_type: 'concierge', state: 'ready', status: 'pending',
    requested_by_member_id: PARENT.member, attempt: 1, max_attempts: 5, lease_owner: 'worker-1', lease_expires_at: '2099-01-01T00:00:00Z',
    cancel_requested_at: null, paused_at: null, progress: {}, created_by: PARENT.user,
  }]);
});

describe('two steps that create the same thing', () => {
  it('write one row; a different assignee is still its own row', async () => {
    const result = await runGraphWith(createExecutorPort(db as unknown as SupabaseClient<Database>), RUN, { budgetMs: 60_000 });

    expect(result.status).toBe('completed');
    const todos = db.table('todo_items').filter((t) => t.family_id === FAMILY);
    expect(todos.map((t) => t.assigned_to_id).sort()).toEqual([CHILD, SIBLING].sort());
    expect(db.table('ai_tool_calls').filter((c) => c.tool_name === 'tasks.createTodo')).toHaveLength(2);
    expect(db.table('ai_plan_steps').every((s) => s.status === 'completed')).toBe(true);
  });
});
