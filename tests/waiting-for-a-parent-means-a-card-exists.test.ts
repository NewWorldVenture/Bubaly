// "Waiting for a parent to approve" is a promise that a card exists for a
// parent to find. When the approval insert failed, the gate still answered
// `pending` with no approval id: chat told the family it was waiting on a
// parent, and a run parked the step on nothing — `reconcileApprovals` and
// `resumeSettledRuns` both skip a step with no approval id, so the run sat in
// `awaiting_approval` forever. One deterministic trigger needed no outage: an
// approval title over the 200 characters `approval_requests.title` allows.
//
// The gate now answers a retryable failure when nothing was filed, the
// executor never parks a step on no row, and titles are clamped. Driven through
// the real executor, `executeTool` and the approval filer.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const hoisted = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => hoisted.db }));

const { createExecutorPort, runGraphWith } = await import('@/lib/ai/runs/executor');

const FAMILY = '00000000-0000-4000-8000-0000000d0d01';
const PARENT = { member: '00000000-0000-4000-8000-0000000d1d01', user: '00000000-0000-4000-8000-0000000d2d01' };
const REQUEST = '00000000-0000-4000-8000-0000000d3d01';
const PLAN = '00000000-0000-4000-8000-0000000d3d02';
const RUN = '00000000-0000-4000-8000-0000000d3d03';

let db: InMemorySupabase;

function seed(step: Record<string, unknown>): void {
  db.seed('families', [{ id: FAMILY, name: 'The Riveras', timezone: 'America/New_York' }]);
  db.seed('family_members', [{ id: PARENT.member, family_id: FAMILY, user_id: PARENT.user, role: 'parent', is_active: true, display_name: 'Dana' }]);
  // "Prepare": every write waits for a yes, so the gate must file a card.
  db.seed('family_ai_settings', [{ family_id: FAMILY, enabled: true, behavior: 'prepare' }]);
  db.seed('ai_requests', [{ id: REQUEST, family_id: FAMILY, requested_by: PARENT.user, requested_by_member_id: PARENT.member, kind: 'concierge', request_text: 'Add it', status: 'ready' }]);
  db.seed('ai_plans', [{ id: PLAN, family_id: FAMILY, request_id: REQUEST, version: 1, status: 'approved', risk_level: 'low' }]);
  db.seed('ai_plan_steps', [{
    id: 'step-1', family_id: FAMILY, plan_id: PLAN, sequence: 0, dependency_ids: [], condition: null, status: 'queued',
    approval_required: false, approval_id: null, risk_level: 'low', retry_count: 0, max_retries: 0, result_json: null, error: null, ...step,
  }]);
  db.seed('family_automation_runs', [{
    id: RUN, family_id: FAMILY, plan_id: PLAN, request_id: REQUEST, run_type: 'concierge', state: 'ready', status: 'pending',
    requested_by_member_id: PARENT.member, attempt: 1, max_attempts: 5, lease_owner: 'worker-1', lease_expires_at: '2099-01-01T00:00:00Z',
    cancel_requested_at: null, paused_at: null, progress: {}, created_by: PARENT.user,
  }]);
}

const run = () => runGraphWith(createExecutorPort(db as unknown as SupabaseClient<Database>), RUN, { budgetMs: 60_000 });

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('a write the gate holds is parked only on an approval that exists', () => {
  it('fails the step, retryably, when the approval could not be filed — never "waiting" on nothing', async () => {
    db = createInMemorySupabase({
      // Every approval insert for this family collides, as a failed write would.
      uniques: { approval_requests: [['family_id']], ai_tool_calls: [['family_id', 'idempotency_key']] },
      defaults: { approval_requests: { status: 'pending', approvals: [] } },
    });
    hoisted.db = db;
    db.seed('approval_requests', [{ id: 'older', family_id: FAMILY, status: 'approved', dedupe_key: 'someone-else', requested_by_kind: 'ai' }]);
    seed({ step_type: 'act', tool_name: 'tasks.createTodo', description: 'Add the to-do', input_json: { title: 'Call the dentist' } });

    const result = await run();

    const [step] = db.table('ai_plan_steps');
    expect(step.status).toBe('failed');
    expect(step.approval_id).toBeNull();
    expect(String(step.error)).toMatch(/could not send that for approval/i);
    expect(result.status).not.toBe('awaiting_approval');
    expect(db.table('family_automation_runs')[0].state).not.toBe('awaiting_approval');
    expect(db.table('approval_requests')).toHaveLength(1);
    expect(db.table('todo_items')).toEqual([]);
  });

  it('files a card whose title fits the column, however long what it names', async () => {
    db = createInMemorySupabase({
      uniques: { ai_tool_calls: [['family_id', 'idempotency_key']] },
      defaults: { approval_requests: { status: 'pending', approvals: [] } },
    });
    hoisted.db = db;
    const long = `Pickup ${'and the very long story about the carpool '.repeat(8)}`.trim();
    seed({ step_type: 'notify', tool_name: null, description: 'Tell everyone', input_json: { recipients: 'family', type: 'system', title: long } });

    await run();

    const [approval] = db.table('approval_requests');
    expect(approval).toBeDefined();
    expect(String(approval.title).length).toBeLessThanOrEqual(200);
    expect(String(approval.title).endsWith('…')).toBe(true);
    expect(db.table('ai_plan_steps')[0]).toMatchObject({ status: 'awaiting_approval', approval_id: approval.id });
  });
});
