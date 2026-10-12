// 0374: a chore assignment is changed by the child it belongs to, or by a
// parent or adult — and an APPROVED one only by a parent or adult, because
// approval is what awards its points. Both rules live in RLS and a trigger
// that steps aside for the service role (`auth.uid() is null`). The run
// executor writes with the service role, so a teen's assistant could mark a
// sibling's chore done, or pull an approved one (and its points) back to
// "submitted". `completeChoreAssignment` now enforces the rule itself.
//
// Driven through the real executor, `executeTool` and the tasks service.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const hoisted = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => hoisted.db }));

const { createExecutorPort, runGraphWith } = await import('@/lib/ai/runs/executor');

const FAMILY = '00000000-0000-4000-8000-0000000a0a01';
const TEEN = { member: '00000000-0000-4000-8000-0000000a1a01', user: '00000000-0000-4000-8000-0000000a2a01' };
const SIBLING = { member: '00000000-0000-4000-8000-0000000a1a02', user: '00000000-0000-4000-8000-0000000a2a02' };
const PARENT = { member: '00000000-0000-4000-8000-0000000a1a03', user: '00000000-0000-4000-8000-0000000a2a03' };
const CHORE = '00000000-0000-4000-8000-0000000a3a01';
const REQUEST = '00000000-0000-4000-8000-0000000a4a01';
const PLAN = '00000000-0000-4000-8000-0000000a4a02';
const RUN = '00000000-0000-4000-8000-0000000a4a03';

let db: InMemorySupabase;

function seed(requester: typeof TEEN, assignment: { id: string; member_id: string; status: string }): void {
  db.seed('families', [{ id: FAMILY, name: 'The Riveras', timezone: 'America/New_York' }]);
  db.seed('family_members', [
    { id: TEEN.member, family_id: FAMILY, user_id: TEEN.user, role: 'teen', is_active: true, display_name: 'Sam' },
    { id: SIBLING.member, family_id: FAMILY, user_id: SIBLING.user, role: 'child', is_active: true, display_name: 'Lily' },
    { id: PARENT.member, family_id: FAMILY, user_id: PARENT.user, role: 'parent', is_active: true, display_name: 'Dana' },
  ]);
  db.seed('chores', [{ id: CHORE, family_id: FAMILY, title: 'Dishes', requires_approval: true, recurrence: null }]);
  db.seed('chore_assignments', [{ ...assignment, family_id: FAMILY, chore_id: CHORE, due_at: '2026-09-06T00:00:00Z', submitted_at: null }]);
  db.seed('ai_requests', [{ id: REQUEST, family_id: FAMILY, requested_by: requester.user, requested_by_member_id: requester.member, kind: 'concierge', request_text: 'Mark the dishes done', status: 'ready' }]);
  db.seed('ai_plans', [{ id: PLAN, family_id: FAMILY, request_id: REQUEST, version: 1, status: 'approved', risk_level: 'low' }]);
  db.seed('ai_plan_steps', [{
    id: 'step-done', family_id: FAMILY, plan_id: PLAN, sequence: 0, step_type: 'act', tool_name: 'tasks.completeChore', description: 'Mark the dishes done',
    input_json: { assignment_id: assignment.id }, dependency_ids: [], condition: null, status: 'queued', approval_required: false,
    approval_id: null, risk_level: 'low', retry_count: 0, max_retries: 0, result_json: null, error: null,
  }]);
  db.seed('family_automation_runs', [{
    id: RUN, family_id: FAMILY, plan_id: PLAN, request_id: REQUEST, run_type: 'concierge', state: 'ready', status: 'pending',
    requested_by_member_id: requester.member, attempt: 1, max_attempts: 5, lease_owner: 'worker-1', lease_expires_at: '2099-01-01T00:00:00Z',
    cancel_requested_at: null, paused_at: null, progress: {}, created_by: requester.user,
  }]);
}

const run = () => runGraphWith(createExecutorPort(db as unknown as SupabaseClient<Database>), RUN, { budgetMs: 60_000 });

beforeEach(() => {
  db = createInMemorySupabase({
    uniques: { ai_tool_calls: [['family_id', 'idempotency_key']] },
    defaults: { ai_tool_calls: { state: 'reserved', attempt: 1, outputs: null, error: null, finished_at: null } },
  });
  hoisted.db = db;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('a chore stays with the child who did it, on the executor’s service client too', () => {
  it('refuses a teen’s assistant marking a sibling’s chore done', async () => {
    seed(TEEN, { id: 'assign-lily', member_id: SIBLING.member, status: 'todo' });

    await run();

    expect(db.table('chore_assignments')[0]).toMatchObject({ status: 'todo', submitted_at: null });
    expect(db.table('ai_plan_steps')[0]).toMatchObject({ status: 'failed' });
  });

  it('refuses a teen’s assistant pulling their own approved chore — and its points — back to "submitted"', async () => {
    seed(TEEN, { id: 'assign-sam', member_id: TEEN.member, status: 'approved' });

    await run();

    expect(db.table('chore_assignments')[0]).toMatchObject({ status: 'approved' });
  });

  it('still lets a teen finish their own chore', async () => {
    seed(TEEN, { id: 'assign-sam', member_id: TEEN.member, status: 'todo' });

    await run();

    expect(db.table('chore_assignments')[0]).toMatchObject({ status: 'submitted' });
    expect(db.table('ai_plan_steps')[0]).toMatchObject({ status: 'completed' });
  });

  it('still lets a parent settle anyone’s chore', async () => {
    seed(PARENT, { id: 'assign-lily', member_id: SIBLING.member, status: 'todo' });

    await run();

    expect(db.table('chore_assignments')[0]).toMatchObject({ status: 'submitted' });
  });
});
