// Policies addressed to Bubaly — "Bubaly may act on the calendar", a learned
// Autopilot allow, the Autopilot dial on "auto" — matched EVERY AI actor,
// whatever the role of the person it acted for. Evaluated before the role
// matrix and naming a domain, such an allow also silenced the risk tier, so a
// guest's or child's assistant was handed writes the role itself is refused,
// and the run executor made them on the service client.
//
// An allow addressed to Bubaly now reaches only requesters whose AI work is
// automation-trusted (parent, adult). For anyone else the role matrix and the
// tier decide, exactly as with no policy; a deny or require_approval still
// binds everyone. Driven through the real executor, `executeTool` and services.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const hoisted = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => hoisted.db }));

const { createExecutorPort, runGraphWith } = await import('@/lib/ai/runs/executor');
const { evaluateAction } = await import('@/lib/trust/engine');

const FAMILY = '00000000-0000-4000-8000-00000000ff01';
const USERS = {
  parent: '00000000-0000-4000-8000-0000000000f1',
  child: '00000000-0000-4000-8000-0000000000f2',
  guest: '00000000-0000-4000-8000-0000000000f3',
} as const;
const MEMBERS = {
  parent: '00000000-0000-4000-8000-00000000fa11',
  child: '00000000-0000-4000-8000-00000000fa12',
  guest: '00000000-0000-4000-8000-00000000fa13',
} as const;
const REQUEST = '00000000-0000-4000-8000-00000000fc11';
const PLAN = '00000000-0000-4000-8000-00000000fc12';
const RUN = '00000000-0000-4000-8000-00000000fc13';
const NOW = new Date('2026-09-05T12:00:00Z');

/** What the Concierge dial writes when it is set to "auto" (dashboard/concierge/actions.ts). */
const DIAL_ON_AUTO = {
  id: 'p-dial', family_id: FAMILY, name: 'Autopilot: scheduling', domain: 'scheduling', capability: 'automate', subject_kind: 'ai',
  effect: 'allow', conditions: {}, approval_model: 'single', required_approvals: 1, priority: 150, enabled: true,
  created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
};

let db: InMemorySupabase;
const client = () => db as unknown as SupabaseClient<Database>;

function seed(who: keyof typeof MEMBERS): void {
  db.seed('families', [{ id: FAMILY, name: 'The Riveras', timezone: 'America/New_York' }]);
  db.seed('family_members', (Object.keys(MEMBERS) as (keyof typeof MEMBERS)[]).map((role) => ({
    id: MEMBERS[role], family_id: FAMILY, user_id: USERS[role], role, is_active: true, display_name: role,
  })));
  db.seed('trust_policies', [DIAL_ON_AUTO]);
  db.seed('ai_requests', [{ id: REQUEST, family_id: FAMILY, requested_by: USERS[who], requested_by_member_id: MEMBERS[who], kind: 'concierge', request_text: 'Remind me', status: 'ready' }]);
  db.seed('ai_plans', [{ id: PLAN, family_id: FAMILY, request_id: REQUEST, version: 1, status: 'approved', risk_level: 'low' }]);
  db.seed('ai_plan_steps', [{
    id: 'step-remind', family_id: FAMILY, plan_id: PLAN, sequence: 0, step_type: 'act', tool_name: 'reminders.create', description: 'Add the reminder',
    input_json: { title: 'Early pickup Thursday', remind_at: '2026-09-10T18:30:00Z' }, dependency_ids: [], condition: null, status: 'queued',
    approval_required: false, approval_id: null, risk_level: 'low', retry_count: 0, max_retries: 0, result_json: null, error: null,
  }]);
  db.seed('family_automation_runs', [{
    id: RUN, family_id: FAMILY, plan_id: PLAN, request_id: REQUEST, run_type: 'concierge', state: 'ready', status: 'pending',
    requested_by_member_id: MEMBERS[who], attempt: 1, max_attempts: 5, lease_owner: 'worker-1', lease_expires_at: '2099-01-01T00:00:00Z',
    cancel_requested_at: null, paused_at: null, progress: {}, created_by: USERS[who],
  }]);
}

beforeEach(() => {
  db = createInMemorySupabase({
    uniques: { ai_tool_calls: [['family_id', 'idempotency_key']] },
    defaults: {
      ai_tool_calls: { state: 'reserved', attempt: 1, outputs: null, error: null, finished_at: null },
      family_reminders: { is_done: false, snoozed_until: null, notes: null, recurrence: 'none' },
      approval_requests: { status: 'pending', approvals: [], edited_payload: null, plan_step_ids: [] },
    },
  });
  hoisted.db = db;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('the Autopilot dial speaks for the managers, not for every assistant', () => {
  it.each(['child', 'guest'] as const)('does not let a %s’s assistant write what the role itself may not', async (who) => {
    seed(who);

    await runGraphWith(createExecutorPort(client()), RUN, { budgetMs: 60_000 });

    expect(db.table('family_reminders')).toEqual([]);
    expect(db.table('ai_plan_steps')[0]).toMatchObject({ status: 'failed' });
  });

  it('still lets a parent’s assistant do what the dial allows', async () => {
    seed('parent');

    await runGraphWith(createExecutorPort(client()), RUN, { budgetMs: 60_000 });

    expect(db.table('family_reminders')).toHaveLength(1);
    expect(db.table('family_reminders')[0]).toMatchObject({ family_id: FAMILY, title: 'Early pickup Thursday' });
  });
});

describe('the engine rule behind it', () => {
  const policy = (effect: 'allow' | 'auto_approve' | 'deny' | 'require_approval') => ({
    id: `p-${effect}`, domain: 'calendar', capability: 'automate' as const, subjectKind: 'ai' as const, effect,
    conditions: { tags: ['calendar.deleteEvent'] }, approvalModel: 'single' as const, requiredApprovals: 1, priority: 200, enabled: true,
  });
  const decide = (role: 'parent' | 'adult' | 'teen' | 'child' | 'caregiver' | 'guest', effect: Parameters<typeof policy>[0]) => evaluateAction({
    actor: { kind: 'ai_agent', id: 'bubaly', role }, domain: 'calendar', capability: 'automate',
    context: { tags: ['calendar.deleteEvent'] }, policies: [policy(effect)],
  });

  it('lets a learned allow reach only automation-trusted requesters', () => {
    expect(decide('parent', 'allow')).toMatchObject({ effect: 'allow', basis: 'policy' });
    expect(decide('adult', 'auto_approve')).toMatchObject({ effect: 'allow', basis: 'policy' });
    for (const role of ['teen', 'child', 'caregiver', 'guest'] as const) {
      // The policy is not about them: the role matrix answers, and none of
      // these roles holds `automate`.
      expect(decide(role, 'allow'), role).toMatchObject({ effect: 'deny', basis: 'fallback' });
    }
  });

  it('keeps every tightening policy binding on every role', () => {
    for (const role of ['parent', 'teen', 'child', 'guest'] as const) {
      expect(decide(role, 'deny'), role).toMatchObject({ effect: 'deny', basis: 'policy' });
      expect(decide(role, 'require_approval'), role).toMatchObject({ effect: 'require_approval', basis: 'policy' });
    }
  });
});
