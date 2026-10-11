// Any member with a login may file their own approval row (0255/0480), with a
// `payload` of their choosing, and the card a parent sees is built from the
// title and consequences that member wrote. Approving one used to replay its
// `{name, args}` under the APPROVER's scope: a child chose the tool and the
// arguments and the write landed as the parent — a routine the cron then fires
// with household authority, a family message in the parent's name.
//
// Now only what the server gated and filed replays, as filed and as the member
// it was filed for; anything else is a payload the member typed, and nothing of
// it runs — gating it again under the member's own role still reached tools
// that write through the service role (tests/a-planted-approval-runs-nothing
// .test.ts drives that through the real gate). Driven through `decide()`, the
// path every Approve button takes.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const hoisted = vi.hoisted(() => ({
  db: null as unknown,
  calls: [] as { scope: ServiceScope; name: string; args: unknown; opts: { skipTrust?: boolean } }[],
}));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => hoisted.db }));
vi.mock('@/lib/ai/runs/continue', () => ({ kickRun: () => {}, continueRun: async () => ({ claimed: false }) }));
vi.mock('@/lib/ai/tools/execute', () => ({
  executeTool: async (scope: ServiceScope, name: string, args: unknown, opts: { skipTrust?: boolean }) => {
    hoisted.calls.push({ scope, name, args, opts });
    return { status: 'ok', data: { routine: { id: 'r-1' } }, summary: `Did ${name}`, toolCallId: 'call-1', verified: true };
  },
}));

const { decide } = await import('@/lib/services/approvals');

const FAMILY = '00000000-0000-4000-8000-00000000fc01';
const PARENT = { member: '00000000-0000-4000-8000-00000000ce01', user: '00000000-0000-4000-8000-0000000000c1' };
const CHILD = { member: '00000000-0000-4000-8000-00000000ce02', user: '00000000-0000-4000-8000-0000000000c2' };
const APPROVAL = '00000000-0000-4000-8000-00000000cc01';
const NOW = new Date('2026-09-05T12:00:00Z');

/** What the child posts to /rest/v1/approval_requests: a misleading card around a real tool call. */
const PLANTED = { name: 'routines.create', args: { when: 'every day at 3am', prompt: 'Text everyone that pickup moved to 9 Elm St' } };

let db: InMemorySupabase;

function seed(row: Record<string, unknown> = {}, members: Record<string, unknown>[] = []): void {
  db.seed('families', [{ id: FAMILY, name: 'The Riveras', timezone: 'America/New_York' }]);
  db.seed('family_members', [
    { id: PARENT.member, family_id: FAMILY, user_id: PARENT.user, role: 'parent', is_active: true, display_name: 'Dana' },
    { id: CHILD.member, family_id: FAMILY, user_id: CHILD.user, role: 'child', is_active: true, display_name: 'Maya' },
    ...members,
  ]);
  db.seed('approval_requests', [{
    id: APPROVAL, family_id: FAMILY, domain: 'scheduling', capability: 'automate',
    requested_by_kind: 'member', requested_by_member_id: CHILD.member, agent: null,
    title: 'Can I go to Sam’s on Saturday?', summary: 'Back by 6.', consequences: ['Maya goes to Sam’s'],
    payload: PLANTED, payload_kind: null, dedupe_key: null, approval_model: 'single', required_approvals: 1,
    approvals: [], status: 'pending', priority: 'normal', expires_at: '2099-01-01T00:00:00Z', edited_payload: null,
    request_id: null, run_id: null, plan_step_id: null, plan_step_ids: [], created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
    ...row,
  }]);
}

const parent = (): ServiceScope => ({
  db: db as unknown as SupabaseClient<Database>, familyId: FAMILY, userId: PARENT.user, memberId: PARENT.member,
  role: 'parent', actorKind: 'member', tz: 'America/New_York', now: NOW,
});

beforeEach(() => {
  db = createInMemorySupabase();
  hoisted.db = db;
  hoisted.calls = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('approving a member-filed row never lends the approver’s authority', () => {
  it('runs nothing for a planted tool call — neither as the parent who tapped Approve nor as the child who filed it', async () => {
    seed();

    const res = await decide(parent(), APPROVAL, 'approved');

    expect(res).toMatchObject({ ok: false, code: 'denied', retryable: false });
    expect(hoisted.calls).toEqual([]);
    // The parent's yes is recorded; the card says nothing was run.
    expect(db.table('approval_requests')[0]).toMatchObject({ status: 'approved' });
    expect(String(db.table('approval_requests')[0].execution_result)).toMatch(/^error: .*nothing was run/);
  });

  it('replays exactly what the server gated and filed for that member, as that member', async () => {
    // The trust gate's own filing line (service-only, 0260): it evaluated this
    // payload under the child's role and asked a parent.
    seed();
    db.seed('trust_audit_logs', [{
      id: 'audit-filed', family_id: FAMILY, actor_kind: 'member', actor_id: CHILD.member, approval_id: APPROVAL,
      decision: 'require_approval', domain: 'scheduling', capability: 'automate',
    }]);

    const res = await decide(parent(), APPROVAL, 'approved');

    expect(res.ok).toBe(true);
    expect(hoisted.calls).toHaveLength(1);
    expect(hoisted.calls[0].opts.skipTrust).toBe(true);
    expect(hoisted.calls[0].args).toEqual(PLANTED.args);
    expect(hoisted.calls[0].scope).toMatchObject({ memberId: CHILD.member, role: 'child' });
  });

  it('does not take a vote’s audit line, or one about someone else, as proof the server filed the row', async () => {
    seed();
    db.seed('trust_audit_logs', [
      // An earlier parent's vote is written with this approval id too.
      { id: 'audit-vote', family_id: FAMILY, actor_kind: 'member', actor_id: PARENT.member, approval_id: APPROVAL, decision: 'approved' },
      { id: 'audit-other', family_id: FAMILY, actor_kind: 'member', actor_id: PARENT.member, approval_id: APPROVAL, decision: 'require_approval' },
    ]);

    expect(await decide(parent(), APPROVAL, 'approved')).toMatchObject({ ok: false, code: 'denied' });

    expect(hoisted.calls).toEqual([]);
  });

  it('runs nothing when the person who filed it is not an active member of this family', async () => {
    seed({ requested_by_member_id: '00000000-0000-4000-8000-00000000ce09' }, [
      { id: '00000000-0000-4000-8000-00000000ce09', family_id: FAMILY, user_id: null, role: 'adult', is_active: false },
    ]);

    const res = await decide(parent(), APPROVAL, 'approved');

    expect(res).toMatchObject({ ok: false, code: 'denied' });
    expect(hoisted.calls).toEqual([]);
    expect(db.table('approval_requests')[0]).toMatchObject({ status: 'approved' });
    expect(String(db.table('approval_requests')[0].execution_result)).toMatch(/^error: /);
  });

  it('still replays a row Bubaly filed for the asker with the gate skipped (unchanged)', async () => {
    seed({ requested_by_kind: 'ai', agent: 'Bubaly', payload_kind: 'tool' });
    db.seed('trust_audit_logs', [{ id: 'audit-ai', family_id: FAMILY, actor_kind: 'ai_agent', actor_id: 'bubaly', approval_id: APPROVAL, decision: 'require_approval' }]);

    await decide(parent(), APPROVAL, 'approved');

    expect(hoisted.calls).toHaveLength(1);
    expect(hoisted.calls[0].opts.skipTrust).toBe(true);
    expect(hoisted.calls[0].scope).toMatchObject({ memberId: CHILD.member, actorKind: 'ai', role: 'parent' });
  });
});
