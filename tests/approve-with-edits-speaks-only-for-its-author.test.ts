// Approved work runs AS the person who asked: a held run step on the service
// client under the requester's member and user ids (lib/ai/runs/executor.ts
// `scopeFor`), a Bubaly-filed card replayed for its asker
// (`scopeForApprovedWork`). `send_family_message`'s "send only as yourself"
// lock does not check the service role (0475). So when another manager used
// Approve-with-edits on a held family message, the run posted their words with
// the requester's name on it — the run page's Edit control was already
// refused (tests/an-edited-step-speaks-only-for-its-author.test.ts); this was
// the same message by the other door.
//
// `editAndApprove` now refuses any change to words said in the asker's name
// unless the asker makes it; approving or declining them as written is
// unchanged. And because `edited_payload` is a column any manager may write on
// a pending row, what runs a first-person edit is the trust ledger, which
// members cannot write: the executor and the card replay run an edit to these
// words only when every recorded edit is the asker's own. Driven through the
// real executor port, `editAndApprove` and `decide`.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

type Executed = { name: string; skipTrust: boolean; memberId: string | null; args: unknown };
const hoisted = vi.hoisted(() => ({ db: null as unknown, executed: [] as Executed[] }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => hoisted.db }));
vi.mock('@/lib/ai/runs/continue', () => ({ kickRun: () => {}, continueRun: async () => ({ claimed: false }) }));
vi.mock('@/lib/ai/tools/execute', () => ({
  executeTool: async (scope: { memberId: string | null }, name: string, args: unknown, opts: { skipTrust: boolean }) => {
    hoisted.executed.push({ name, skipTrust: opts.skipTrust, memberId: scope.memberId, args });
    return { status: 'ok', data: { id: 'message-1' }, summary: `Did ${name}`, toolCallId: 'call-1', verified: true };
  },
}));

const { createExecutorPort, runGraphWith } = await import('@/lib/ai/runs/executor');
const { decide, editAndApprove } = await import('@/lib/services/approvals');

const FAMILY = '00000000-0000-4000-8000-00000000fe01';
const DANA = { member: '00000000-0000-4000-8000-00000000ee01', user: '00000000-0000-4000-8000-0000000000e1' };
const ALEX = { member: '00000000-0000-4000-8000-00000000ee02', user: '00000000-0000-4000-8000-0000000000e2' };
const REQUEST = '00000000-0000-4000-8000-00000000ec01';
const PLAN = '00000000-0000-4000-8000-00000000ec02';
const RUN = '00000000-0000-4000-8000-00000000ec03';
const STEP = '00000000-0000-4000-8000-00000000ec04';
const CARD = '00000000-0000-4000-8000-00000000ec05';
const NOW = new Date('2026-09-05T12:00:00Z');
const NOT_YOURS = 'This speaks in the name of the person who asked, so only they can change its words. You can still approve or decline it as written.';

let db: InMemorySupabase;
const client = () => db as unknown as SupabaseClient<Database>;

function household(policies: Record<string, unknown>[] = []): void {
  db.seed('families', [{ id: FAMILY, name: 'The Riveras', timezone: 'America/New_York' }]);
  db.seed('family_members', [
    { id: DANA.member, family_id: FAMILY, user_id: DANA.user, role: 'parent', is_active: true, display_name: 'Dana' },
    { id: ALEX.member, family_id: FAMILY, user_id: ALEX.user, role: 'parent', is_active: true, display_name: 'Alex' },
  ]);
  db.seed('trust_policies', policies);
}

/** Dana's run, holding one step of hers for approval, as the planner saved it. */
function heldStep(toolName: string, input: Record<string, unknown>): void {
  db.seed('ai_requests', [{ id: REQUEST, family_id: FAMILY, requested_by: DANA.user, requested_by_member_id: DANA.member, kind: 'concierge', request_text: 'Tell the family dinner is at 7', status: 'ready' }]);
  db.seed('ai_plans', [{ id: PLAN, family_id: FAMILY, request_id: REQUEST, version: 1, status: 'approved', risk_level: 'medium' }]);
  db.seed('ai_plan_steps', [{
    id: STEP, family_id: FAMILY, plan_id: PLAN, sequence: 0, step_type: 'act', tool_name: toolName, description: 'Tell the family',
    input_json: input, dependency_ids: [], condition: null, status: 'queued', approval_required: true, approval_id: null,
    risk_level: 'medium', retry_count: 0, max_retries: 2, result_json: null, error: null,
  }]);
  db.seed('family_automation_runs', [{
    id: RUN, family_id: FAMILY, plan_id: PLAN, request_id: REQUEST, run_type: 'concierge', state: 'ready', status: 'pending',
    requested_by_member_id: DANA.member, attempt: 1, max_attempts: 5, lease_owner: 'worker-1', lease_expires_at: '2099-01-01T00:00:00Z',
    cancel_requested_at: null, paused_at: null, progress: {}, created_by: DANA.user,
  }]);
}

const as = (who: typeof DANA): ServiceScope => ({
  db: client(), familyId: FAMILY, userId: who.user, memberId: who.member, role: 'parent', actorKind: 'member', tz: 'America/New_York', now: NOW,
});

/** Run Dana's run to its approval and return the card it filed. */
async function cardForHeldStep(): Promise<string> {
  await runGraphWith(createExecutorPort(client()), RUN, { budgetMs: 60_000 });
  const [row] = db.table('approval_requests');
  expect(row, 'the held step filed no card').toBeTruthy();
  return String(row.id);
}

/** Let the run pick its released step up, as the cron or `kickRun` would. */
async function resume(): Promise<void> {
  db.table('family_automation_runs')[0].state = 'ready';
  await runGraphWith(createExecutorPort(client()), RUN, { budgetMs: 60_000 });
}

beforeEach(() => {
  db = createInMemorySupabase({ defaults: { approval_requests: { approvals: [], edited_payload: null, plan_step_ids: [] } } });
  hoisted.db = db;
  hoisted.executed = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('Approve-with-edits on a held run step that speaks in the requester’s name', () => {
  it('refuses another manager’s rewording — nothing is recorded and nothing is posted as the requester', async () => {
    household();
    heldStep('messages.sendFamilyMessage', { content: 'Dinner at 7' });
    const card = await cardForHeldStep();

    const res = await editAndApprove(as(ALEX), card, { content: 'Alex wrote this' });

    expect(res).toEqual({ ok: false, error: NOT_YOURS, code: 'denied' });
    expect(db.table('approval_requests')[0]).toMatchObject({ status: 'pending', edited_payload: null, approvals: [] });
    await resume();
    expect(hoisted.executed).toEqual([]);
  });

  it('leaves the other manager free to approve it exactly as written, which runs the requester’s own words', async () => {
    household();
    heldStep('messages.sendFamilyMessage', { content: 'Dinner at 7' });
    const card = await cardForHeldStep();

    expect(await decide(as(ALEX), card, 'approved')).toMatchObject({ ok: true, data: { status: 'approved' } });
    await resume();

    expect(hoisted.executed).toEqual([{ name: 'messages.sendFamilyMessage', skipTrust: true, memberId: DANA.member, args: { content: 'Dinner at 7' } }]);
  });

  it('lets the requester reword their own message and runs what they wrote', async () => {
    household();
    heldStep('messages.sendFamilyMessage', { content: 'Dinner at 7' });
    const card = await cardForHeldStep();

    expect(await editAndApprove(as(DANA), card, { content: 'Dinner at 7:30' })).toMatchObject({ ok: true, data: { status: 'modified' } });
    await resume();

    expect(hoisted.executed).toEqual([{ name: 'messages.sendFamilyMessage', skipTrust: true, memberId: DANA.member, args: { content: 'Dinner at 7:30' } }]);
  });

  it('on a two-parent card, runs the requester’s rewording once the other parent approves it — plainly or by re-submitting it unchanged', async () => {
    household([{
      id: '00000000-0000-4000-8000-00000000ec06', family_id: FAMILY, name: 'Messages need both of us', domain: 'messaging', capability: 'automate',
      subject_kind: 'ai', effect: 'require_approval', conditions: {}, approval_model: 'two_parent', required_approvals: 2, priority: 200, enabled: true,
      created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
    }]);
    heldStep('messages.sendFamilyMessage', { content: 'Dinner at 7' });
    const card = await cardForHeldStep();
    expect(db.table('approval_requests')[0]).toMatchObject({ approval_model: 'two_parent', required_approvals: 2 });

    expect(await editAndApprove(as(DANA), card, { content: 'Dinner at 7:30' })).toMatchObject({ ok: true, data: { status: 'pending' } });
    expect(await editAndApprove(as(ALEX), card, { content: 'Dinner at 7:30' })).toMatchObject({ ok: true, data: { status: 'modified' } });
    await resume();

    expect(hoisted.executed).toEqual([{ name: 'messages.sendFamilyMessage', skipTrust: true, memberId: DANA.member, args: { content: 'Dinner at 7:30' } }]);
  });

  it('runs the requester’s own words when the edit on the card is not theirs on the ledger — written to the column directly', async () => {
    household();
    heldStep('messages.sendFamilyMessage', { content: 'Dinner at 7' });
    const card = await cardForHeldStep();
    // `approval_requests_decide` lets any manager PATCH `edited_payload` on a
    // pending row over /rest/v1; no `editAndApprove` ran, so the ledger has no edit.
    db.table('approval_requests')[0].edited_payload = { content: 'Alex wrote this' };

    expect(await decide(as(ALEX), card, 'approved')).toMatchObject({ ok: true, data: { status: 'approved' } });
    await resume();

    expect(hoisted.executed).toEqual([{ name: 'messages.sendFamilyMessage', skipTrust: true, memberId: DANA.member, args: { content: 'Dinner at 7' } }]);
  });

  it('still lets another manager correct a held step that speaks for no one', async () => {
    household();
    heldStep('tasks.createTodo', { title: 'Buy candles' });
    const card = await cardForHeldStep();

    expect(await editAndApprove(as(ALEX), card, { title: 'Buy birthday candles' })).toMatchObject({ ok: true, data: { status: 'modified' } });
    await resume();

    expect(hoisted.executed).toEqual([{ name: 'tasks.createTodo', skipTrust: true, memberId: DANA.member, args: { title: 'Buy birthday candles' } }]);
  });
});

describe('Approve-with-edits on a chat card Bubaly filed for the asker', () => {
  /** "Tell the family dinner is at 7", held by the gate for Dana and filed by Bubaly (the server's ledger line). */
  function chatCard(name: string, args: Record<string, unknown>): void {
    db.seed('approval_requests', [{
      id: CARD, family_id: FAMILY, domain: 'messaging', capability: 'automate', approval_model: 'single', required_approvals: 1,
      requested_by_kind: 'ai', requested_by_member_id: DANA.member, agent: 'Bubaly', title: 'Tell the family', summary: null,
      payload: { name, args }, payload_kind: 'tool', run_id: null, request_id: null, plan_step_id: null, plan_step_ids: [], status: 'pending',
      created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
    }]);
    db.seed('trust_audit_logs', [{ family_id: FAMILY, actor_kind: 'ai_agent', actor_id: 'bubaly', approval_id: CARD, decision: 'require_approval', context: {} }]);
  }

  it('refuses another manager’s rewording of the message, under its chat name too', async () => {
    household();
    chatCard('send_family_message', { content: 'Dinner at 7' });

    expect(await editAndApprove(as(ALEX), CARD, { content: 'Alex wrote this' })).toEqual({ ok: false, error: NOT_YOURS, code: 'denied' });
    expect(hoisted.executed).toEqual([]);
    expect(db.table('approval_requests')[0]).toMatchObject({ status: 'pending', edited_payload: null });
  });

  it('replays what the asker filed, not an edit written to the column, when another manager approves it', async () => {
    household();
    chatCard('messages.sendFamilyMessage', { content: 'Dinner at 7' });
    db.table('approval_requests')[0].edited_payload = { content: 'Alex wrote this' };

    expect(await decide(as(ALEX), CARD, 'approved')).toMatchObject({ ok: true, data: { executed: true } });

    expect(hoisted.executed).toEqual([{ name: 'messages.sendFamilyMessage', skipTrust: true, memberId: DANA.member, args: { content: 'Dinner at 7' } }]);
  });

  it('replays the asker’s own rewording', async () => {
    household();
    chatCard('messages.sendFamilyMessage', { content: 'Dinner at 7' });

    expect(await editAndApprove(as(DANA), CARD, { content: 'Dinner at 7:30' })).toMatchObject({ ok: true, data: { status: 'modified' } });

    expect(hoisted.executed).toEqual([{ name: 'messages.sendFamilyMessage', skipTrust: true, memberId: DANA.member, args: { content: 'Dinner at 7:30' } }]);
  });
});
