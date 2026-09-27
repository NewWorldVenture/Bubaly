// m7r2 — What the second approver's card showed is what the executor runs.
//
// m8 collapsed three derivations of "what will this approval do" onto one pure
// function, `effectiveArgsOf` (lib/approvals/card-data.ts): the card renders
// it, `decide()` executes it (`storedEdit`), `editAndApprove` merges onto it.
// It admits only the scalar fields Bubaly's ORIGINAL ask carried, and only
// scalar values — an edit is a correction of what was shown, never a way to
// smuggle in an argument.
//
// The run executor was the fourth reader and used none of it. `loadApproval`
// (lib/ai/runs/executor.ts) selected `edited_payload` and the approval gate ran
// that object as the tool's arguments with `skipTrust: true`. `edited_payload`
// is a column `approval_requests_decide` (0251) lets any manager write on a
// pending row, so a value written to the column directly — a member id the
// plan never named, a nested object, a key the card never offered — ran while
// the card showed the allow-listed version. `executeTool` still parses the
// tool's schema, but a tool's schema accepts far more than the card offered.
//
// Every assertion here is on the arguments the tool actually received, through
// the REAL executor port over the in-memory database, so both halves are on
// trial: the port must fetch the ask the card was built from, and the gate must
// derive from it.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const executed = vi.hoisted(() => ({ calls: [] as { name: string; args: unknown; skipTrust: boolean }[] }));

vi.mock('@/lib/ai/tools/execute', () => ({
  executeTool: async (_scope: unknown, name: string, args: unknown, opts: { skipTrust: boolean }) => {
    executed.calls.push({ name, args, skipTrust: opts.skipTrust });
    return { status: 'ok', data: { id: 'ev-1' }, summary: `Did ${name}`, toolCallId: 'call-1', verified: true };
  },
}));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => { throw new Error('the test hands the port its own client'); },
  createServer: async () => { throw new Error('the test hands the port its own client'); },
}));

const { createExecutorPort, runGraphWith } = await import('@/lib/ai/runs/executor');

const FAMILY = '00000000-0000-4000-8000-00000000fa02';
const USER = '00000000-0000-4000-8000-0000000000a2';
const PARENT = '00000000-0000-4000-8000-00000000ae01';
const CHILD = '00000000-0000-4000-8000-00000000ae02';
const REQUEST = '00000000-0000-4000-8000-00000000cc01';
const PLAN = '00000000-0000-4000-8000-00000000cc02';
const RUN = '00000000-0000-4000-8000-00000000cc03';
const STEP = '00000000-0000-4000-8000-00000000cc04';
const APPROVAL = '00000000-0000-4000-8000-00000000cc05';

/** Bubaly's original ask: the step's input, which is also what the approval was filed with. */
const ORIGINAL = { title: 'Soccer', starts_at: '2026-09-06T13:00:00Z', assignee_id: CHILD };

let db: InMemorySupabase;

function seedRunAwaitingApproval(approval: Record<string, unknown>): void {
  db.seed('families', [{ id: FAMILY, name: 'The Hughens', timezone: 'America/New_York', created_by: USER }]);
  db.seed('family_members', [
    { id: PARENT, family_id: FAMILY, user_id: USER, display_name: 'Dan', role: 'parent', is_active: true },
    { id: CHILD, family_id: FAMILY, user_id: null, display_name: 'Maya', role: 'child', is_active: true },
  ]);
  db.seed('ai_requests', [{ id: REQUEST, family_id: FAMILY, requested_by: USER, requested_by_member_id: PARENT, kind: 'concierge', request_text: 'Add soccer', status: 'awaiting_approval' }]);
  db.seed('ai_plans', [{ id: PLAN, family_id: FAMILY, request_id: REQUEST, version: 1, status: 'approved', risk_level: 'low' }]);
  db.seed('ai_plan_steps', [{
    id: STEP, family_id: FAMILY, plan_id: PLAN, sequence: 0, step_type: 'act', tool_name: 'calendar.createEvent',
    description: 'Add soccer Saturday', input_json: ORIGINAL, dependency_ids: [], condition: null,
    status: 'awaiting_approval', approval_required: true, approval_id: APPROVAL, risk_level: 'medium',
    retry_count: 0, max_retries: 2, result_json: null, error: null, started_at: null, completed_at: null,
  }]);
  db.seed('family_automation_runs', [{
    id: RUN, family_id: FAMILY, plan_id: PLAN, request_id: REQUEST, run_type: 'concierge', state: 'awaiting_approval',
    status: 'pending', requested_by_member_id: PARENT, attempt: 1, max_attempts: 5, lease_owner: 'worker-1',
    lease_expires_at: '2099-01-01T00:00:00Z', cancel_requested_at: null, paused_at: null, progress: {}, created_by: USER,
  }]);
  db.seed('approval_requests', [{
    id: APPROVAL, family_id: FAMILY, domain: 'calendar', capability: 'automate', requested_by_kind: 'ai',
    requested_by_member_id: PARENT, agent: 'concierge', title: 'Add soccer Saturday', summary: null,
    // Exactly what the port's `requestApproval` files for a gated step.
    payload: { kind: 'plan_steps', run_id: RUN, step_ids: [STEP], input: ORIGINAL },
    payload_kind: 'plan_steps', run_id: RUN, request_id: REQUEST, plan_step_id: STEP, plan_step_ids: [STEP],
    approval_model: 'two_parent', required_approvals: 1, priority: 'normal', consequences: [],
    expires_at: '2099-01-01T00:00:00Z', decided_by: PARENT, decided_at: '2026-09-05T12:00:00Z',
    ...approval,
  }]);
}

async function runOnce(): Promise<void> {
  const port = createExecutorPort(db as unknown as SupabaseClient<Database>);
  await runGraphWith(port, RUN, { budgetMs: 60_000 });
}

beforeEach(() => {
  executed.calls = [];
  db = createInMemorySupabase({ userId: USER });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('an approved step runs what the approvers were shown', () => {
  it('runs the original when nothing was edited', async () => {
    seedRunAwaitingApproval({ status: 'approved', edited_payload: null });

    await runOnce();

    expect(executed.calls).toHaveLength(1);
    expect(executed.calls[0]).toMatchObject({ name: 'calendar.createEvent', args: ORIGINAL, skipTrust: true });
    expect(db.table('ai_plan_steps')[0].status).toBe('completed');
  });

  it('honours a correction to a field the card offered', async () => {
    seedRunAwaitingApproval({
      status: 'modified',
      edited_payload: { ...ORIGINAL, title: 'Soccer — bring boots and shin pads' },
    });

    await runOnce();

    expect(executed.calls).toHaveLength(1);
    expect(executed.calls[0].args).toEqual({ ...ORIGINAL, title: 'Soccer — bring boots and shin pads' });
  });

  it('does NOT run an argument the card never offered, even though the tool would accept it', async () => {
    // Written to the column directly, past `editAndApprove`: a key the plan
    // never carried, a nested value, and a bookkeeping key. `assignee_id` is a
    // scalar the original DID carry, so changing it is a correction the card
    // offers and it goes through — which is what makes the rest a bypass and
    // not a blanket refusal of edits.
    seedRunAwaitingApproval({
      status: 'approved',
      edited_payload: {
        ...ORIGINAL,
        assignee_id: PARENT,
        attendee_ids: [CHILD, PARENT],
        location: { lat: 51.5, lng: -0.12 },
        family_id: '00000000-0000-4000-8000-00000000dead',
      },
    });

    await runOnce();

    expect(executed.calls).toHaveLength(1);
    const args = executed.calls[0].args as Record<string, unknown>;
    expect(args).toEqual({ ...ORIGINAL, assignee_id: PARENT });
    expect(args).not.toHaveProperty('attendee_ids');
    expect(args).not.toHaveProperty('location');
    expect(args).not.toHaveProperty('family_id');
  });

  it('falls back to the original when the stored edit changes nothing the card offered', async () => {
    seedRunAwaitingApproval({
      status: 'approved',
      edited_payload: { member_id: CHILD, notes: { private: true } },
    });

    await runOnce();

    expect(executed.calls).toHaveLength(1);
    expect(executed.calls[0].args).toEqual(ORIGINAL);
  });

  it('does not treat a non-object edit as arguments', async () => {
    seedRunAwaitingApproval({ status: 'approved', edited_payload: 'drop everything' });

    await runOnce();

    expect(executed.calls).toHaveLength(1);
    expect(executed.calls[0].args).toEqual(ORIGINAL);
  });
});
