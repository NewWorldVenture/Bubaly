// A plan's `notify` step pushed text to every phone in the house through the
// notifications service directly — never `executeTool`, so none of what the
// registry's own `notifications.notify` answers to applied: the requester's
// role (a guest's or child's assistant may not message the family), "Bubaly
// is switched off", the messaging dial, the family's policies, the ledger.
// `urgent: true` skipped quiet hours for anyone.
//
// A notify step is now delivered AS `notifications.notify`, through the same
// gate, under the requester's role. Driven through the real executor port,
// the real `executeTool` and the real notifications service, over the
// in-memory database.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const hoisted = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => hoisted.db }));

const { createExecutorPort, runGraphWith } = await import('@/lib/ai/runs/executor');
const { validatePlan, catalogueNames } = await import('@/lib/ai/planner/validate');
const { listTools } = await import('@/lib/ai/tools/registry');

const FAMILY = '00000000-0000-4000-8000-00000000fe01';
const PARENT = { member: '00000000-0000-4000-8000-00000000ee01', user: '00000000-0000-4000-8000-0000000000e1' };
const CHILD = { member: '00000000-0000-4000-8000-00000000ee02', user: '00000000-0000-4000-8000-0000000000e2' };
const REQUEST = '00000000-0000-4000-8000-00000000ec01';
const PLAN = '00000000-0000-4000-8000-00000000ec02';
const RUN = '00000000-0000-4000-8000-00000000ec03';
const STEP = '00000000-0000-4000-8000-00000000ec04';
const NOW = new Date('2026-09-05T12:00:00Z');

let db: InMemorySupabase;
const client = () => db as unknown as SupabaseClient<Database>;

function seed(requester: typeof PARENT, extra: { settings?: Record<string, unknown>; policies?: Record<string, unknown>[] } = {}): void {
  db.seed('families', [{ id: FAMILY, name: 'The Riveras', timezone: 'America/New_York' }]);
  db.seed('family_members', [
    { id: PARENT.member, family_id: FAMILY, user_id: PARENT.user, role: 'parent', is_active: true, display_name: 'Dana' },
    { id: CHILD.member, family_id: FAMILY, user_id: CHILD.user, role: 'child', is_active: true, display_name: 'Maya' },
  ]);
  if (extra.settings) db.seed('family_ai_settings', [{ family_id: FAMILY, ...extra.settings }]);
  if (extra.policies) db.seed('trust_policies', extra.policies);
  db.seed('ai_requests', [{ id: REQUEST, family_id: FAMILY, requested_by: requester.user, requested_by_member_id: requester.member, kind: 'concierge', request_text: 'Tell everyone pickup moved', status: 'ready' }]);
  db.seed('ai_plans', [{ id: PLAN, family_id: FAMILY, request_id: REQUEST, version: 1, status: 'approved', risk_level: 'low' }]);
  db.seed('ai_plan_steps', [{
    id: STEP, family_id: FAMILY, plan_id: PLAN, sequence: 0, step_type: 'notify', tool_name: null, description: 'Tell everyone',
    input_json: { recipients: 'family', type: 'system', title: 'Pickup moved to 9 Elm St', body: 'Today, 3pm.', urgent: true },
    dependency_ids: [], condition: null, status: 'queued', approval_required: false, approval_id: null,
    risk_level: 'low', retry_count: 0, max_retries: 0, result_json: null, error: null,
  }]);
  db.seed('family_automation_runs', [{
    id: RUN, family_id: FAMILY, plan_id: PLAN, request_id: REQUEST, run_type: 'concierge', state: 'ready', status: 'pending',
    requested_by_member_id: requester.member, attempt: 1, max_attempts: 5, lease_owner: 'worker-1', lease_expires_at: '2099-01-01T00:00:00Z',
    cancel_requested_at: null, paused_at: null, progress: {}, created_by: requester.user,
  }]);
}

const run = () => runGraphWith(createExecutorPort(client()), RUN, { budgetMs: 60_000 });
const sent = () => db.table('notifications').filter((n) => n.family_id === FAMILY);
const ledgered = () => db.table('ai_tool_calls').filter((c) => c.tool_name === 'notifications.notify');

beforeEach(() => {
  db = createInMemorySupabase({
    uniques: { ai_tool_calls: [['family_id', 'idempotency_key']] },
    defaults: {
      notifications: { is_read: false, body: null, link: null },
      ai_tool_calls: { state: 'reserved', attempt: 1, outputs: null, error: null, finished_at: null },
      approval_requests: { status: 'pending', approvals: [], edited_payload: null, plan_step_ids: [] },
    },
  });
  hoisted.db = db;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('a planned notification is gated like the tool it is', () => {
  it('refuses a child’s assistant, as `notifications.notify` would — nothing reaches anyone’s phone', async () => {
    seed(CHILD);

    await run();

    expect(sent()).toEqual([]);
    expect(db.table('ai_plan_steps')[0]).toMatchObject({ status: 'failed' });
    expect(db.table('ai_run_events').some((e) => e.event_type === 'step_failed')).toBe(true);
  });

  it('holds a parent’s notification for a yes when the family set messaging to "prepare"', async () => {
    seed(PARENT, { settings: { enabled: true, behavior: 'execute', category_behavior: { messaging: 'prepare' } } });

    await run();

    expect(sent()).toEqual([]);
    const [approval] = db.table('approval_requests');
    expect(approval).toMatchObject({ domain: 'messaging', payload: { name: 'notifications.notify' } });
    expect(db.table('ai_plan_steps')[0]).toMatchObject({ status: 'awaiting_approval', approval_id: approval.id });
  });

  it('sends nothing while Bubaly is switched off', async () => {
    seed(PARENT, { settings: { enabled: false, behavior: 'execute' } });

    await run();

    expect(sent()).toEqual([]);
    expect(db.table('ai_plan_steps')[0]).toMatchObject({ status: 'failed' });
  });

  it('still sends a parent’s notification, through the ledger, urgent as they asked', async () => {
    seed(PARENT);

    await run();

    expect(sent().map((n) => n.user_id).sort()).toEqual([PARENT.user, CHILD.user].sort());
    expect(db.table('ai_plan_steps')[0]).toMatchObject({ status: 'completed', result_json: { count: 2 } });
    expect(ledgered()).toHaveLength(1);
    expect(ledgered()[0]).toMatchObject({ state: 'succeeded', run_id: RUN, inputs: { title: 'Pickup moved to 9 Elm St', urgent: true } });
  });

  it('lets only a parent or adult skip quiet hours: a child the family let notify sends it as an ordinary notice', async () => {
    seed(CHILD, { policies: [{
      id: 'p-kids-may-notify', family_id: FAMILY, name: 'Maya may message us', domain: 'messaging', capability: 'automate',
      subject_kind: 'role', subject_role: 'child', effect: 'allow', conditions: {}, approval_model: 'single', required_approvals: 1,
      priority: 100, enabled: true, created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
    }] });

    await run();

    expect(sent()).toHaveLength(2);
    expect(ledgered()[0]).toMatchObject({ inputs: { urgent: false } });
  });
});

describe('the planner asks the same question before the run exists', () => {
  it('leaves a notify step out of a child’s plan, and keeps it in a parent’s', () => {
    const plan = {
      objective: 'Tell everyone', reasoning_summary: '', risk_level: 'low' as const, followups: [], clarification: null, answer: null,
      steps: [{ key: 'tell', step_type: 'notify' as const, tool_name: null, description: 'Tell everyone', input: '{"recipients":"family","type":"system","title":"Pickup moved"}', depends_on: [], condition: null, approval_required: null, verify: null }],
    };
    const inputs = (role: 'child' | 'parent') => ({
      policies: [], grants: [], delegations: [], emergencyDomains: [], role, now: NOW, tz: 'America/New_York', allowedTools: catalogueNames(listTools()),
    });

    const child = validatePlan(plan, inputs('child'));
    expect(child.ok).toBe(false);
    expect(child.issues.map((i) => [i.code, i.step])).toContainEqual(['denied', 'tell']);

    const parent = validatePlan(plan, inputs('parent'));
    expect(parent.ok && parent.steps.map((s) => [s.key, s.approvalRequired])).toEqual([['tell', false]]);
  });
});
