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

  it('refuses another manager’s rewording of a held announcement, which the board posts under the requester’s name', async () => {
    household();
    heldStep('messages.createAnnouncement', { title: 'Dinner at 7' });
    const card = await cardForHeldStep();

    const res = await editAndApprove(as(ALEX), card, { title: 'Dinner is cancelled, Dana says' });

    expect(res).toEqual({ ok: false, error: NOT_YOURS, code: 'denied' });
    expect(db.table('approval_requests')[0]).toMatchObject({ status: 'pending', edited_payload: null, approvals: [] });
    await resume();
    expect(hoisted.executed).toEqual([]);
  });

  it('lets the requester reword their own held announcement and runs what they wrote', async () => {
    household();
    heldStep('messages.createAnnouncement', { title: 'Dinner at 7' });
    const card = await cardForHeldStep();

    expect(await editAndApprove(as(DANA), card, { title: 'Dinner at 7:30' })).toMatchObject({ ok: true, data: { status: 'modified' } });
    await resume();

    expect(hoisted.executed).toEqual([{ name: 'messages.createAnnouncement', skipTrust: true, memberId: DANA.member, args: { title: 'Dinner at 7:30' } }]);
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

  it('refuses another manager’s rewording of an announcement card, under its chat name too', async () => {
    household();
    chatCard('create_announcement', { title: 'Dinner at 7' });

    expect(await editAndApprove(as(ALEX), CARD, { title: 'Dinner is cancelled, Dana says' })).toEqual({ ok: false, error: NOT_YOURS, code: 'denied' });
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



describe('private current-head intent-value counterexamples', () => {
  it('never emits a substituted run payload under the prior requester-only edit history', async () => {
    household([{ id: '00000000-0000-4000-8000-00000000ec06', family_id: FAMILY, name: 'Messages need both of us', domain: 'messaging', capability: 'automate', subject_kind: 'ai', effect: 'require_approval', conditions: {}, approval_model: 'two_parent', required_approvals: 2, priority: 200, enabled: true, created_at: NOW.toISOString(), updated_at: NOW.toISOString() }]);
    heldStep('messages.sendFamilyMessage', { content: 'Dinner at 7' });
    const card = await cardForHeldStep();
    expect(await editAndApprove(as(DANA), card, { content: 'Dinner at 7:30' })).toMatchObject({ ok: true, data: { status: 'pending' } });
    expect(db.table('trust_audit_logs').some((r) => r.actor_id === DANA.member && r.decision === 'modified')).toBe(true);
    db.table('approval_requests')[0].edited_payload = { content: 'Alex substituted this after Dana voted' };
    await decide(as(ALEX), card, 'approved');
    await resume();
    expect(hoisted.executed).not.toContainEqual(expect.objectContaining({ memberId: DANA.member, args: { content: 'Alex substituted this after Dana voted' } }));
  });

  it('never emits a substituted standalone payload under the prior requester-only edit history', async () => {
    household([{ id: '00000000-0000-4000-8000-00000000ec06', family_id: FAMILY, name: 'Messages need both of us', domain: 'messaging', capability: 'automate', subject_kind: 'ai', effect: 'require_approval', conditions: {}, approval_model: 'two_parent', required_approvals: 2, priority: 200, enabled: true, created_at: NOW.toISOString(), updated_at: NOW.toISOString() }]);
    db.seed('approval_requests', [{ id: CARD, family_id: FAMILY, domain: 'messaging', capability: 'automate', approval_model: 'two_parent', required_approvals: 2, requested_by_kind: 'ai', requested_by_member_id: DANA.member, agent: 'Bubaly', title: 'Tell the family', summary: null, payload: { name: 'messages.sendFamilyMessage', args: { content: 'Dinner at 7' } }, payload_kind: 'tool', run_id: null, request_id: null, plan_step_id: null, plan_step_ids: [], status: 'pending', created_at: NOW.toISOString(), updated_at: NOW.toISOString() }]);
    db.seed('trust_audit_logs', [{ family_id: FAMILY, actor_kind: 'ai_agent', actor_id: 'bubaly', approval_id: CARD, decision: 'require_approval', context: {} }]);
    expect(await editAndApprove(as(DANA), CARD, { content: 'Dinner at 7:30' })).toMatchObject({ ok: true, data: { status: 'pending' } });
    expect(db.table('trust_audit_logs').some((r) => r.actor_id === DANA.member && r.decision === 'modified')).toBe(true);
    db.table('approval_requests')[0].edited_payload = { content: 'Alex substituted this after Dana voted' };
    await decide(as(ALEX), CARD, 'approved');
    expect(hoisted.executed).not.toContainEqual(expect.objectContaining({ memberId: DANA.member, args: { content: 'Alex substituted this after Dana voted' } }));
  });
});


import { withFaults } from './helpers/in-memory-supabase';
import { firstPersonEditProof, requesterEditedArgsAreProven, type RecordedEdit } from '@/lib/ai/tools/first-person';

type ApprovalPath = 'held run' | 'standalone card';
const FIRST_EDIT = 'Dinner at 7:30';
const SUBSTITUTED = 'Alex substituted this after Dana voted';

async function pendingMessage(path: ApprovalPath, edit = true): Promise<string> {
  household([{ id: '00000000-0000-4000-8000-00000000ec06', family_id: FAMILY, name: 'Messages need both of us', domain: 'messaging', capability: 'automate', subject_kind: 'ai', effect: 'require_approval', conditions: {}, approval_model: 'two_parent', required_approvals: 2, priority: 200, enabled: true, created_at: NOW.toISOString(), updated_at: NOW.toISOString() }]);
  let card: string;
  if (path === 'held run') {
    heldStep('messages.sendFamilyMessage', { content: 'Dinner at 7' });
    card = await cardForHeldStep();
  } else {
    card = CARD;
    db.seed('approval_requests', [{ id: CARD, family_id: FAMILY, domain: 'messaging', capability: 'automate', approval_model: 'two_parent', required_approvals: 2, requested_by_kind: 'ai', requested_by_member_id: DANA.member, agent: 'Bubaly', title: 'Tell the family', summary: null, payload: { name: 'messages.sendFamilyMessage', args: { content: 'Dinner at 7' } }, payload_kind: 'tool', run_id: null, request_id: null, plan_step_id: null, plan_step_ids: [], status: 'pending', created_at: NOW.toISOString(), updated_at: NOW.toISOString() }]);
    db.seed('trust_audit_logs', [{ family_id: FAMILY, actor_kind: 'ai_agent', actor_id: 'bubaly', approval_id: CARD, decision: 'require_approval', context: {} }]);
  }
  if (edit) expect(await editAndApprove(as(DANA), card, { content: FIRST_EDIT })).toMatchObject({ ok: true, data: { status: 'pending' } });
  return card;
}

function actualProofRecord(): Record<string, unknown> {
  const record = db.table('trust_audit_logs').find((row) => row.actor_id === DANA.member && row.decision === 'modified');
  expect(record, 'the real edit wrote no protected ledger evidence').toBeTruthy();
  return record!;
}

function actualProof(): Record<string, unknown> {
  const context = actualProofRecord().context as Record<string, unknown>;
  expect(context.firstPersonEdit).toBeTruthy();
  return context.firstPersonEdit as Record<string, unknown>;
}

async function approveAndFinish(path: ApprovalPath, card: string): Promise<void> {
  expect(await decide(as(ALEX), card, 'approved')).toMatchObject({ ok: true, data: { status: 'approved' } });
  if (path === 'held run') await resume();
}

const fallbackMessage = () => [{ name: 'messages.sendFamilyMessage', skipTrust: true, memberId: DANA.member, args: { content: 'Dinner at 7' } }];
const editedMessage = (content = FIRST_EDIT) => [{ name: 'messages.sendFamilyMessage', skipTrust: true, memberId: DANA.member, args: { content } }];

for (const path of ['held run', 'standalone card'] as const) {
  describe(`exact first-person value evidence on a ${path}`, () => {
    it('writes a protected value digest bound to family, approval, requester and canonical tool without copying private words', async () => {
      const card = await pendingMessage(path);
      expect(actualProof()).toMatchObject({ version: 1, familyId: FAMILY, approvalId: card, requesterMemberId: DANA.member, toolNames: ['messages.sendFamilyMessage'], argsDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
      expect(JSON.stringify(actualProofRecord().context)).not.toContain(FIRST_EDIT);
      await approveAndFinish(path, card);
      expect(hoisted.executed).toEqual(editedMessage());
    });

    for (const [name, corrupt] of [
      ['missing proof', (context: Record<string, unknown>) => { delete context.firstPersonEdit; }],
      ['non-object proof', (context: Record<string, unknown>) => { context.firstPersonEdit = 'not a proof'; }],
      ['malformed changed-field evidence', (context: Record<string, unknown>) => { context.changedByMe = [42]; }],
      ['extra proof fields', (context: Record<string, unknown>) => { (context.firstPersonEdit as Record<string, unknown>).extra = true; }],
      ['another family', (context: Record<string, unknown>) => { (context.firstPersonEdit as Record<string, unknown>).familyId = 'another-family'; }],
      ['another approval', (context: Record<string, unknown>) => { (context.firstPersonEdit as Record<string, unknown>).approvalId = 'another-approval'; }],
      ['another requester', (context: Record<string, unknown>) => { (context.firstPersonEdit as Record<string, unknown>).requesterMemberId = ALEX.member; }],
      ['another tool', (context: Record<string, unknown>) => { (context.firstPersonEdit as Record<string, unknown>).toolNames = ['calendar.rsvp']; }],
      ['wrong digest', (context: Record<string, unknown>) => { (context.firstPersonEdit as Record<string, unknown>).argsDigest = '0'.repeat(64); }],
      ['malformed version', (context: Record<string, unknown>) => { (context.firstPersonEdit as Record<string, unknown>).version = '1'; }],
    ] as const) {
      it(`sets aside an edit with ${name} and retains the original requester words`, async () => {
        const card = await pendingMessage(path);
        corrupt(actualProofRecord().context as Record<string, unknown>);
        await approveAndFinish(path, card);
        expect(hoisted.executed).toEqual(fallbackMessage());
      });
    }

    it('does not certify a substituted column when another parent re-submits it identically', async () => {
      const card = await pendingMessage(path);
      db.table('approval_requests')[0].edited_payload = { content: SUBSTITUTED };
      const beforeEvidence = structuredClone(db.table('trust_audit_logs'));
      expect(await editAndApprove(as(ALEX), card, { content: SUBSTITUTED })).toEqual({ ok: false, error: NOT_YOURS, code: 'denied' });
      expect(db.table('approval_requests')[0]).toMatchObject({ status: 'pending', approvals: [expect.objectContaining({ member_id: DANA.member })] });
      expect(db.table('trust_audit_logs')).toEqual(beforeEvidence);
      if (path === 'held run') await resume();
      expect(hoisted.executed).toEqual([]);
    });

    it('preserves a legitimate unchanged second approval through Edit', async () => {
      const card = await pendingMessage(path);
      expect(await editAndApprove(as(ALEX), card, { content: FIRST_EDIT })).toMatchObject({ ok: true, data: { status: 'modified' } });
      if (path === 'held run') await resume();
      expect(hoisted.executed).toEqual(editedMessage());
      expect(db.table('trust_audit_logs').filter((row) => (row.context as Record<string, unknown>)?.firstPersonEdit)).toHaveLength(1);
    });

    it('lets the requester explicitly replace an unproven pending column with their own new wording', async () => {
      const card = await pendingMessage(path, false);
      db.table('approval_requests')[0].edited_payload = { content: SUBSTITUTED };
      expect(await editAndApprove(as(DANA), card, { content: 'Dana explicitly wrote this' })).toMatchObject({ ok: true, data: { status: 'pending' } });
      await approveAndFinish(path, card);
      expect(hoisted.executed).toEqual(editedMessage('Dana explicitly wrote this'));
    });

    it('never uses an older matching proof after a newer protected edit changed the wording', async () => {
      const card = await pendingMessage(path);
      const old = actualProofRecord();
      const newer = structuredClone(old);
      newer.id = 'newer-protected-edit';
      newer.created_at = new Date(Date.parse(String(old.created_at)) + 1000).toISOString();
      (newer.context as Record<string, unknown>).firstPersonEdit = firstPersonEditProof({ familyId: FAMILY, approvalId: card, requesterMemberId: DANA.member }, ['messages.sendFamilyMessage'], { content: 'Dana later wrote something different' });
      db.table('trust_audit_logs').push(newer);
      await approveAndFinish(path, card);
      expect(hoisted.executed).toEqual(fallbackMessage());
    });

    it('refuses to choose between different protected edits with the same timestamp', async () => {
      const card = await pendingMessage(path);
      const conflicting = structuredClone(actualProofRecord());
      conflicting.id = 'same-time-protected-edit';
      (conflicting.context as Record<string, unknown>).firstPersonEdit = firstPersonEditProof({ familyId: FAMILY, approvalId: card, requesterMemberId: DANA.member }, ['messages.sendFamilyMessage'], { content: 'Different simultaneous wording' });
      db.table('trust_audit_logs').push(conflicting);
      await approveAndFinish(path, card);
      expect(hoisted.executed).toEqual(fallbackMessage());
    });

    it('does not run an unproven edit when the protected edit read is unavailable', async () => {
      const card = await pendingMessage(path);
      db = withFaults(db, (table, calls) => table === 'trust_audit_logs' && calls.some((call) => call.method === 'eq' && call.args[0] === 'decision' && call.args[1] === 'modified') ? { message: 'synthetic protected evidence read unavailable' } : null);
      hoisted.db = db;
      await approveAndFinish(path, card);
      expect(hoisted.executed).toEqual(path === 'held run' ? [] : fallbackMessage());
    });

    it('does not run changed words after a lost protected evidence write', async () => {
      const card = await pendingMessage(path, false);
      db = withFaults(db, (table, calls) => table === 'trust_audit_logs' && calls.some((call) => call.method === 'insert' && (call.args[0] as Record<string, unknown>)?.decision === 'modified') ? { message: 'synthetic protected evidence write unavailable' } : null);
      hoisted.db = db;
      expect(await editAndApprove(as(DANA), card, { content: FIRST_EDIT })).toMatchObject({ ok: true, data: { status: 'pending' } });
      await approveAndFinish(path, card);
      expect(hoisted.executed).toEqual(fallbackMessage());
    });
  });
}

describe('exact first-person proof normalization', () => {
  const identity = { familyId: FAMILY, approvalId: CARD, requesterMemberId: DANA.member };
  const evidence = (args: Record<string, unknown>): RecordedEdit[] => [{ actorId: DANA.member, changedFields: ['content'], createdAt: NOW.toISOString(), firstPersonEdit: firstPersonEditProof(identity, ['send_family_message'], args) }];

  it('accepts alias/canonical tool identity and reordered nested JSON keys without changing values', () => {
    expect(requesterEditedArgsAreProven(evidence({ content: FIRST_EDIT, metadata: { a: true, b: [1, null] } }), { ...identity, toolName: 'messages.sendFamilyMessage' }, { metadata: { b: [1, null], a: true }, content: FIRST_EDIT })).toBe(true);
  });

  it('does not normalize a different string into the authorized words', () => {
    expect(requesterEditedArgsAreProven(evidence({ content: FIRST_EDIT }), { ...identity, toolName: 'send_family_message' }, { content: ` ${FIRST_EDIT} ` })).toBe(false);
  });

  it('does not produce evidence for non-JSON arguments or a non-first-person tool', () => {
    expect(firstPersonEditProof(identity, ['messages.sendFamilyMessage'], { content: FIRST_EDIT, invalid: undefined })).toBeNull();
    expect(firstPersonEditProof(identity, ['tasks.createTodo'], { title: 'Shared task' })).toBeNull();
  });
});
