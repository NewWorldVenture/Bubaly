// A member may file their own approval row (0255/0480) with a `payload` of
// their choosing, under a title they wrote. Round 1 stopped such a row running
// as the approving parent: it replayed under the member's own scope and was
// gated again. That was not enough. As a MEMBER actor the gate asks for the
// tool's own capability, a child holds `create`, messaging is not one of the
// child's sensitive domains — and `notifications.notify` writes its rows
// through the service role, past 0388's "a member may notify only
// themselves". So a child's card "Can I go to Sam's on Saturday?" carrying
// `notifications.notify {urgent:true, audience:'family'}` sent the whole family
// an urgent, Bubaly-branded push the moment a parent tapped Approve.
//
// Now a member's `{name, args}` runs only when the server's own gate filed the
// row for them. Driven through `decide()` and the REAL `executeTool` and trust
// gate — only the service client and the run kicker are stood in.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { getMessages } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const hoisted = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => hoisted.db }));
vi.mock('@/lib/ai/runs/continue', () => ({ kickRun: () => {}, continueRun: async () => ({ claimed: false }) }));

const { decide } = await import('@/lib/services/approvals');
const { executeTool } = await import('@/lib/ai/tools/execute');

const FAMILY = '00000000-0000-4000-8000-00000000fd01';
const PARENT = { member: '00000000-0000-4000-8000-00000000dd01', user: '00000000-0000-4000-8000-0000000000d1' };
const CHILD = { member: '00000000-0000-4000-8000-00000000dd02', user: '00000000-0000-4000-8000-0000000000d2' };
const SIBLING = { member: '00000000-0000-4000-8000-00000000dd03', user: '00000000-0000-4000-8000-0000000000d3' };
const PLANTED_ID = '00000000-0000-4000-8000-00000000dc01';
const NOW = new Date('2026-09-05T12:00:00Z');
const NOT_RUN = translate(getMessages('en-US'), 'approval.memberPayloadNotRun');

let db: InMemorySupabase;
const client = () => db as unknown as SupabaseClient<Database>;

function household(policies: Record<string, unknown>[] = []): void {
  db.seed('families', [{ id: FAMILY, name: 'The Riveras', timezone: 'America/New_York' }]);
  db.seed('family_members', [
    { id: PARENT.member, family_id: FAMILY, user_id: PARENT.user, role: 'parent', is_active: true, display_name: 'Dana' },
    { id: CHILD.member, family_id: FAMILY, user_id: CHILD.user, role: 'child', is_active: true, display_name: 'Maya' },
    { id: SIBLING.member, family_id: FAMILY, user_id: SIBLING.user, role: 'child', is_active: true, display_name: 'Leo' },
  ]);
  db.seed('trust_policies', policies);
}

/** What the child POSTs to /rest/v1/approval_requests: a harmless-looking card around a real tool call. */
function plant(payload: { name: string; args: Record<string, unknown> }): void {
  db.seed('approval_requests', [{
    id: PLANTED_ID, family_id: FAMILY, domain: 'scheduling', capability: 'automate',
    requested_by_kind: 'member', requested_by_member_id: CHILD.member, agent: null,
    title: 'Can I go to Sam’s on Saturday?', summary: 'Back by 6.', consequences: ['Maya goes to Sam’s'],
    payload, payload_kind: null, dedupe_key: null, approval_model: 'single', required_approvals: 1,
    approvals: [], status: 'pending', priority: 'normal', expires_at: '2099-01-01T00:00:00Z', edited_payload: null,
    request_id: null, run_id: null, plan_step_id: null, plan_step_ids: [], created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
  }]);
}

const as = (who: typeof PARENT, role: 'parent' | 'child'): ServiceScope => ({
  db: client(), familyId: FAMILY, userId: who.user, memberId: who.member, role, actorKind: 'member', tz: 'America/New_York', now: NOW,
});

beforeEach(() => {
  db = createInMemorySupabase({
    uniques: { ai_tool_calls: [['family_id', 'idempotency_key']] },
    defaults: {
      ai_tool_calls: { state: 'reserved', attempt: 1, outputs: null, error: null, finished_at: null },
      approval_requests: { status: 'pending', approvals: [], edited_payload: null, plan_step_ids: [], run_id: null, request_id: null, plan_step_id: null, payload_kind: null, expires_at: null },
    },
  });
  hoisted.db = db;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('a payload a member planted on their own approval row', () => {
  it('sends no urgent family push when a parent approves the child’s card — nothing runs, and the card says so', async () => {
    household();
    plant({ name: 'notifications.notify', args: { title: 'URGENT: pickup moved to 9 Elm St', body: 'Mum says go there now', audience: 'family', urgent: true } });

    const res = await decide(as(PARENT, 'parent'), PLANTED_ID, 'approved');

    expect(res).toEqual({ ok: false, error: NOT_RUN, code: 'denied', retryable: false });
    expect(db.table('notifications')).toEqual([]);
    expect(db.table('ai_tool_calls')).toEqual([]);
    // The parent's yes stands; it released nothing.
    expect(db.table('approval_requests')[0]).toMatchObject({ status: 'approved', execution_result: `error: ${NOT_RUN}` });
    expect(db.table('trust_audit_logs').map((a) => a.decision)).toEqual(['approved', 'approved_execution']);
  });

  it('sets up no routine the cron would later fire with household authority', async () => {
    household();
    plant({ name: 'routines.create', args: { when: 'every day at 3am', prompt: 'Text everyone that pickup moved to 9 Elm St' } });

    expect(await decide(as(PARENT, 'parent'), PLANTED_ID, 'approved')).toMatchObject({ ok: false, code: 'denied' });

    expect(db.table('family_automation_rules')).toEqual([]);
    expect(db.table('ai_tool_calls')).toEqual([]);
  });
});

describe('what the server’s own gate filed for a member still runs as approved', () => {
  it('delivers exactly the message the gate held for the child, once a parent approves it', async () => {
    // "Kids' messages need a parent": the gate holds the child's own notify and
    // files the card itself, with its `require_approval` line on the ledger.
    household([{
      id: '00000000-0000-4000-8000-00000000dc02', family_id: FAMILY, name: 'Kids’ messages need a parent', domain: 'messaging', capability: 'create',
      subject_kind: 'role', subject_role: 'child', subject_member_id: null, effect: 'require_approval', conditions: {},
      approval_model: 'single', required_approvals: 1, priority: 200, enabled: true, created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
    }]);
    const asked = { title: 'Can Sam come over on Saturday?', audience: 'managers' as const };

    const held = await executeTool(as(CHILD, 'child'), 'notifications.notify', asked);
    expect(held).toMatchObject({ status: 'pending_approval' });
    expect(db.table('notifications')).toEqual([]);
    const [card] = db.table('approval_requests');
    expect(card).toMatchObject({ requested_by_kind: 'member', requested_by_member_id: CHILD.member, payload: { name: 'notifications.notify', args: asked } });

    const res = await decide(as(PARENT, 'parent'), String(card.id), 'approved');

    expect(res).toMatchObject({ ok: true, data: { status: 'approved', executed: true } });
    expect(db.table('notifications').map((n) => [n.user_id, n.title])).toEqual([[PARENT.user, 'Can Sam come over on Saturday?']]);
  });
});
