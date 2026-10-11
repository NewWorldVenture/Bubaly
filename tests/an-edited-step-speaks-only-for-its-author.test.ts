// A run acts as the person who asked for it, on the service client — and
// `send_family_message`'s "send only as yourself" lock does not check the
// service role (0475). So when another manager edited the words of a
// `messages.sendFamilyMessage` step in someone else's run, the message went
// out with the requester's name on it. And because the edit requeued the step
// under a new id (a new idempotency key), editing one that had already run
// sent it again.
//
// `editStepInput` now refuses both: words said in someone's name are theirs to
// change, and a step that already ran is not re-done by an edit. Driven
// through `editStepInput`, the run page's Edit control.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => { throw new Error('the test passes its own ledger'); } }));

const { editStepInput } = await import('@/lib/ai/runs/controls');

const FAMILY = '00000000-0000-4000-8000-0000000b0b01';
const ALICE = { member: '00000000-0000-4000-8000-0000000b1b01', user: '00000000-0000-4000-8000-0000000b2b01' };
const BOB = { member: '00000000-0000-4000-8000-0000000b1b02', user: '00000000-0000-4000-8000-0000000b2b02' };
const REQUEST = '00000000-0000-4000-8000-0000000b3b01';
const PLAN = '00000000-0000-4000-8000-0000000b3b02';
const RUN = '00000000-0000-4000-8000-0000000b3b03';

let db: InMemorySupabase;

function seed(steps: { id: string; tool_name: string; status: string; input_json: Record<string, unknown> }[]): void {
  db.seed('families', [{ id: FAMILY, name: 'The Riveras', timezone: 'America/New_York' }]);
  db.seed('ai_requests', [{ id: REQUEST, family_id: FAMILY, requested_by: ALICE.user, requested_by_member_id: ALICE.member, kind: 'concierge', request_text: 'Tell the family dinner is at 7', status: 'ready' }]);
  db.seed('ai_plans', [{ id: PLAN, family_id: FAMILY, request_id: REQUEST, version: 1, status: 'approved', risk_level: 'low' }]);
  db.seed('ai_plan_steps', steps.map((step, i) => ({
    ...step, family_id: FAMILY, plan_id: PLAN, sequence: i, step_type: 'act', description: step.tool_name, dependency_ids: [], condition: null,
    approval_required: false, approval_id: null, risk_level: 'low', retry_count: 0, max_retries: 2, result_json: null, error: null,
  })));
  db.seed('family_automation_runs', [{
    id: RUN, family_id: FAMILY, plan_id: PLAN, request_id: REQUEST, run_type: 'concierge', state: 'awaiting_approval', status: 'pending',
    requested_by_member_id: ALICE.member, attempt: 1, max_attempts: 5, lease_owner: null, lease_expires_at: null,
    cancel_requested_at: null, paused_at: null, progress: {}, created_by: ALICE.user,
  }]);
}

const as = (who: typeof ALICE, role: 'parent' | 'adult'): ServiceScope => ({
  db: db as unknown as SupabaseClient<Database>, familyId: FAMILY, userId: who.user, memberId: who.member, role, actorKind: 'member', tz: 'America/New_York',
});
const opts = () => ({ db: db as unknown as SupabaseClient<Database> });
const plans = () => db.table('ai_plans').filter((p) => p.request_id === REQUEST);

beforeEach(() => {
  db = createInMemorySupabase();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('an edit to a step that speaks in the requester’s name', () => {
  it('is refused when another manager makes it, and nothing is re-planned', async () => {
    seed([{ id: 'step-msg', tool_name: 'messages.sendFamilyMessage', status: 'queued', input_json: { content: 'Dinner is at 7' } }]);

    const res = await editStepInput(as(BOB, 'adult'), RUN, 'step-msg', { content: 'Dinner is cancelled, order pizza' }, opts());

    expect(res).toMatchObject({ ok: false, code: 'denied' });
    expect(plans()).toHaveLength(1);
    expect(db.table('ai_plan_steps').map((s) => s.input_json)).toEqual([{ content: 'Dinner is at 7' }]);
  });

  it('is accepted from the person who asked', async () => {
    seed([{ id: 'step-msg', tool_name: 'messages.sendFamilyMessage', status: 'queued', input_json: { content: 'Dinner is at 7' } }]);

    const res = await editStepInput(as(ALICE, 'parent'), RUN, 'step-msg', { content: 'Dinner is at 7:30' }, opts());

    expect(res.ok, res.ok ? '' : res.error).toBe(true);
    expect(plans()).toHaveLength(2);
  });

  it('is refused for an announcement too: the board posts it under the requester’s name', async () => {
    // `createAnnouncement` writes `author_id`/`author_member_id` from the run's
    // scope, and 0481 lets no member post as another directly.
    seed([{ id: 'step-ann', tool_name: 'messages.createAnnouncement', status: 'failed', input_json: { title: 'Dinner at 7' } }]);

    const res = await editStepInput(as(BOB, 'adult'), RUN, 'step-ann', { title: 'Dinner is cancelled, Alice says' }, opts());

    expect(res).toMatchObject({ ok: false, code: 'denied' });
    expect(plans()).toHaveLength(1);
    expect(db.table('ai_plan_steps').map((s) => s.input_json)).toEqual([{ title: 'Dinner at 7' }]);
  });

  it('accepts the requester’s own rewording of their announcement', async () => {
    seed([{ id: 'step-ann', tool_name: 'messages.createAnnouncement', status: 'failed', input_json: { title: 'Dinner at 7' } }]);

    const res = await editStepInput(as(ALICE, 'parent'), RUN, 'step-ann', { title: 'Dinner at 7:30' }, opts());

    expect(res.ok, res.ok ? '' : res.error).toBe(true);
    expect(plans()).toHaveLength(2);
  });

  it('leaves another manager free to correct a step that speaks for no one', async () => {
    seed([{ id: 'step-todo', tool_name: 'tasks.createTodo', status: 'queued', input_json: { title: 'Buy candles' } }]);

    const res = await editStepInput(as(BOB, 'adult'), RUN, 'step-todo', { title: 'Buy birthday candles' }, opts());

    expect(res.ok, res.ok ? '' : res.error).toBe(true);
  });
});

describe('an edit to a step that already ran', () => {
  it.each(['completed', 'partially_completed', 'executing'])('is refused for a %s step — an edit must not do the work again', async (status) => {
    seed([{ id: 'step-msg', tool_name: 'messages.sendFamilyMessage', status, input_json: { content: 'Dinner is at 7' } }]);

    const res = await editStepInput(as(ALICE, 'parent'), RUN, 'step-msg', { content: 'Dinner is at 7' }, opts());

    expect(res).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(plans()).toHaveLength(1);
  });
});
