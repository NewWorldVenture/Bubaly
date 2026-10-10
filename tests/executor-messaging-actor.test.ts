import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { createExecutorPort, type RunSnapshot } from '@/lib/ai/runs/executor';
import type { Database } from '@/lib/database.types';
import { sendFamilyMessage } from '@/lib/services/messages';
import type { ServiceScope } from '@/lib/services/types';

const FAMILY = '10000000-0000-4000-8000-000000000001';
const OTHER_FAMILY = '10000000-0000-4000-8000-000000000002';
const MEMBER = '20000000-0000-4000-8000-000000000001';
const OTHER_MEMBER = '20000000-0000-4000-8000-000000000002';
const USER = '30000000-0000-4000-8000-000000000001';
const PLAN = '40000000-0000-4000-8000-000000000001';
const REQUEST = '50000000-0000-4000-8000-000000000001';
const CHAT = '60000000-0000-4000-8000-000000000001';
const RUN = '70000000-0000-4000-8000-000000000001';
const MESSAGE = '80000000-0000-4000-8000-000000000001';

type Row = Record<string, unknown>;
type TransportCall = { table: string; method: string; args: Row };

function run(patch: Partial<RunSnapshot> = {}): RunSnapshot {
  return {
    id: RUN, family_id: FAMILY, plan_id: PLAN, request_id: REQUEST,
    state: 'ready', requested_by_member_id: null, cancel_requested_at: null,
    paused_at: null, attempt: 0, max_attempts: 3, lease_owner: null, ...patch,
  };
}

/**
 * Only the database transport is replaced. The executor, store actor lookup,
 * request check, messaging service, activity service and Supabase client run
 * unchanged. These tests prove actor binding; the SQL fixtures prove RPC RLS.
 */
function transport(requester: string | null = null) {
  const rows: Record<string, Row[]> = {
    families: [{ id: FAMILY, timezone: 'UTC' }],
    family_members: [{
      id: MEMBER, family_id: FAMILY, user_id: USER, role: 'parent',
      display_name: 'Synthetic parent', is_active: true, birthday: null,
      color: null, avatar_url: null,
    }],
    ai_plans: [{ id: PLAN, family_id: FAMILY, request_id: REQUEST }],
    ai_requests: [{ id: REQUEST, family_id: FAMILY, requested_by_member_id: requester }],
  };
  const calls: TransportCall[] = [];
  const json = (value: unknown) => new Response(JSON.stringify(value), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
  const db = createClient<Database>('https://synthetic.invalid', 'synthetic-test-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: {
      async fetch(input, init) {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        const method = init?.method ?? 'GET';
        const table = url.pathname.replace('/rest/v1/', '');
        const args: Row = init?.body ? JSON.parse(String(init.body)) as Row : Object.fromEntries(url.searchParams);
        calls.push({ table, method, args });
        if (method === 'GET') {
          if (!rows[table]) throw new Error(`Unexpected synthetic table: ${table}`);
          return json(rows[table].filter((row) => [...url.searchParams].every(([column, filter]) => {
            if (column === 'select') return true;
            if (!filter.startsWith('eq.')) throw new Error(`Unexpected synthetic filter: ${filter}`);
            return String(row[column]) === filter.slice(3);
          })));
        }
        if (method !== 'POST') throw new Error(`Unexpected synthetic method: ${method}`);
        switch (table) {
          case 'rpc/ensure_family_conversation': return json(CHAT);
          case 'rpc/find_family_message': return json([]);
          case 'rpc/send_family_message': return json({
            id: MESSAGE, family_id: args.p_family_id, conversation_id: args.p_conversation_id,
            sender_id: args.p_user_id, sender_member_id: args.p_member_id,
            sender_name: args.p_member_id ? 'Synthetic parent' : 'Bubaly',
            content: args.p_content, kind: args.p_kind, reply_to_id: args.p_reply_to_id,
          });
          case 'audit_logs': return json(null);
          case 'agent_activity': return json({ id: 'synthetic-activity' });
          default: throw new Error(`Unexpected synthetic write: ${table}`);
        }
      },
    },
  });
  return { db, rows, calls };
}

describe('executor scopes retain the verified messaging actor', () => {
  it.each([PLAN, null])('lets an ownerless routine send as system (plan %s)', async (planId) => {
    const { db, calls } = transport();
    const scope = await createExecutorPort(db).scopeFor(run({ plan_id: planId }));
    expect(scope).toMatchObject({ ok: true, data: {
      familyId: FAMILY, userId: null, memberId: null, role: 'system',
    } });
    if (!scope.ok) throw new Error(scope.error);
    expect(await sendFamilyMessage(scope.data, { content: 'Synthetic routine reminder' }))
      .toMatchObject({ ok: true, data: { id: MESSAGE, sender_id: null, sender_member_id: null } });
    expect(scope.data.actorKind).toBe('system');
    expect(calls.filter((call) => call.table.startsWith('rpc/')).map((call) => call.table))
      .toEqual(['rpc/ensure_family_conversation', 'rpc/find_family_message', 'rpc/send_family_message']);
    for (const call of calls.filter((entry) => entry.table.startsWith('rpc/'))) {
      expect(call.args).toMatchObject({ p_family_id: FAMILY, p_member_id: null, p_user_id: null });
    }
    expect(calls.find((call) => call.table === 'audit_logs')?.args)
      .toMatchObject({ actor_id: null, metadata: { actor: 'system' } });
  });

  it('keeps an active parent as AI acting for that verified requester', async () => {
    const { db, calls } = transport(MEMBER);
    const scope = await createExecutorPort(db).scopeFor(run({ requested_by_member_id: MEMBER }));
    expect(scope).toMatchObject({ ok: true, data: {
      userId: USER, memberId: MEMBER, role: 'parent', actorKind: 'ai',
    } });
    if (!scope.ok) throw new Error(scope.error);
    expect(await sendFamilyMessage(scope.data, { content: 'Synthetic parent reminder' }))
      .toMatchObject({ ok: true, data: { sender_id: USER, sender_member_id: MEMBER } });
    for (const call of calls.filter((entry) => entry.table.startsWith('rpc/'))) {
      expect(call.args).toMatchObject({ p_family_id: FAMILY, p_member_id: MEMBER, p_user_id: USER });
    }
    expect(calls.find((call) => call.table === 'audit_logs')?.args)
      .toMatchObject({ actor_id: USER, metadata: { actor: 'ai' } });
  });

  it.each(['inactive', 'foreign'] as const)('denies an %s run requester before any messaging RPC', async (condition) => {
    const { db, rows, calls } = transport(MEMBER);
    if (condition === 'inactive') rows.family_members[0].is_active = false;
    else rows.family_members[0].family_id = OTHER_FAMILY;
    expect(await createExecutorPort(db).scopeFor(run({ requested_by_member_id: MEMBER })))
      .toMatchObject({ ok: false, code: 'denied' });
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
  });

  it('denies a member removed after scope creation when the service rechecks membership', async () => {
    const { db, rows, calls } = transport(MEMBER);
    const scope = await createExecutorPort(db).scopeFor(run({ requested_by_member_id: MEMBER }));
    if (!scope.ok) throw new Error(scope.error);
    rows.family_members[0].is_active = false;
    expect(await sendFamilyMessage(scope.data, { content: 'Synthetic late reminder' }))
      .toMatchObject({ ok: false, code: 'denied' });
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
  });

  it.each(['foreign plan', 'foreign request', 'wrong plan request', 'different requester', 'ownerless borrowed request'] as const)
    ('denies a %s before granting a messaging scope', async (condition) => {
      const ownerless = condition === 'ownerless borrowed request';
      const { db, rows, calls } = transport(MEMBER);
      if (condition === 'foreign plan') rows.ai_plans[0].family_id = OTHER_FAMILY;
      if (condition === 'foreign request') rows.ai_requests[0].family_id = OTHER_FAMILY;
      if (condition === 'wrong plan request') rows.ai_plans[0].request_id = 'different-request';
      if (condition === 'different requester') rows.ai_requests[0].requested_by_member_id = OTHER_MEMBER;
      expect(await createExecutorPort(db).scopeFor(run({ requested_by_member_id: ownerless ? null : MEMBER })))
        .toMatchObject({ ok: false, code: 'denied' });
      expect(calls.every((call) => call.method === 'GET')).toBe(true);
    });

  it('does not relabel a managed member without a login as a system actor', async () => {
    const { db, rows, calls } = transport(MEMBER);
    rows.family_members[0].user_id = null;
    rows.family_members[0].role = 'child';
    const scope = await createExecutorPort(db).scopeFor(run({ requested_by_member_id: MEMBER }));
    expect(scope).toMatchObject({ ok: true, data: {
      userId: null, memberId: MEMBER, role: 'child', actorKind: 'ai',
    } });
    if (!scope.ok) throw new Error(scope.error);
    expect(await sendFamilyMessage(scope.data, { content: 'Synthetic managed-member message' }))
      .toMatchObject({ ok: false, code: 'denied' });
    expect(calls.every((call) => call.method === 'GET')).toBe(true);
  });

  it('still denies a direct unattributed AI scope even when its role says system', async () => {
    const { db, calls } = transport();
    const scope: ServiceScope = {
      db, familyId: FAMILY, userId: null, memberId: null, role: 'system', actorKind: 'ai', tz: 'UTC',
    };
    expect(await sendFamilyMessage(scope, { content: 'Synthetic unattributed message' }))
      .toMatchObject({ ok: false, code: 'denied' });
    expect(calls).toEqual([]);
  });
});
