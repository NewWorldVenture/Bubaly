// Service boundary tests complement the real-role PostgreSQL fixture. A
// privileged executor must carry the actual actor to the atomic send RPC.
// Owner decision (production has not taken 0475): when PostgREST answers that
// exactly one of the 0475 objects is missing, that path does what the previous
// production build did (82f2db1); any other error still fails visibly.
import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import {
  createAnnouncement,
  ensureFamilyConversation,
  sendFamilyMessage,
} from '@/lib/services/messages';
import type { ServiceScope } from '@/lib/services/types';

type Call = { table: string; kind: 'select' | 'insert' | 'update' | 'delete'; filters: Record<string, unknown>; payload?: unknown };
type Reply = { data: unknown; error: unknown };

function makeDb(respond: (call: Call) => Reply) {
  const calls: Call[] = [];
  const from = (table: string) => {
    const call: Call = { table, kind: 'select', filters: {} };
    calls.push(call);
    const b: Record<string, unknown> = {};
    const chain = () => b;
    const filter = (column: string, value: unknown) => { call.filters[column] = value; return b; };
    Object.assign(b, {
      select: chain, order: chain, limit: chain, or: chain, ilike: chain,
      eq: filter, is: filter, in: filter,
      gte: (c: string, v: unknown) => filter(`gte:${c}`, v),
      insert: (payload: unknown) => { call.kind = 'insert'; call.payload = payload; return b; },
      update: (payload: unknown) => { call.kind = 'update'; call.payload = payload; return b; },
      delete: () => { call.kind = 'delete'; return b; },
      single: () => Promise.resolve(respond(call)),
      maybeSingle: () => Promise.resolve(respond(call)),
      then: (resolve: (value: Reply) => void) => resolve(respond(call)),
    });
    return b;
  };
  const rpc = (name: string, args: Record<string, unknown> = {}) => {
    const call: Call = { table: `rpc:${name}`, kind: 'select', filters: args };
    calls.push(call);
    return Promise.resolve(respond(call));
  };
  return { db: { from, rpc } as unknown as SupabaseClient<Database>, calls };
}

const NOW = new Date('2026-09-05T12:00:00Z');
/** PostgREST's answer for an RPC this database does not have. */
const MISSING = (name: string) => ({ code: 'PGRST202', message: `Could not find the function public.${name} in the schema cache`, details: null, hint: null });

function scopeWith(db: SupabaseClient<Database>, extra?: Partial<ServiceScope>): ServiceScope {
  return {
    db, familyId: 'fam-1', userId: 'auth-user-1', memberId: 'member-1', role: 'parent',
    actorKind: 'member', tz: 'America/New_York', now: NOW, ...extra,
  };
}

const MEMBERS = [
  { id: 'member-1', family_id: 'fam-1', user_id: 'auth-user-1', display_name: 'Dana', role: 'parent', birthday: null, is_active: true, color: null, avatar_url: null },
  { id: 'member-2', family_id: 'fam-1', user_id: null, display_name: 'Ava', role: 'child', birthday: null, is_active: true, color: null, avatar_url: null },
];

const MESSAGE = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: 'msg-1', conversation_id: 'conv-1', family_id: 'fam-1', sender_id: 'auth-user-1', sender_name: 'Dana', sender_avatar: null,
  content: 'Dinner at 6!', kind: 'text', attachment_url: null, attachment_name: null, attachment_mime: null, reply_to_id: null,
  reactions: {}, read_by: [], is_pinned: false, deleted_at: null, created_at: NOW.toISOString(), ...overrides,
});

const CONVERSATION = (overrides: Record<string, unknown> = {}) => ({
  id: 'conv-1', is_family_chat: false, is_archived: false,
  participant_ids: ['member-1', 'member-2'], member_ids: ['auth-user-1'], created_by: 'auth-user-1', ...overrides,
});

function successfulReply(call: Call): Reply {
  if (call.table === 'family_members') return { data: MEMBERS[0], error: null };
  if (call.table === 'family_conversations') return { data: CONVERSATION(), error: null };
  if (call.table === 'rpc:ensure_family_conversation') return { data: 'conv-canonical', error: null };
  if (call.table === 'rpc:send_family_message') return { data: MESSAGE({ conversation_id: call.filters.p_conversation_id }), error: null };
  return { data: null, error: null };
}

describe('ensureFamilyConversation', () => {
  it('uses the canonical RPC without looking up or adopting a legacy group', async () => {
    const { db, calls } = makeDb(successfulReply);
    const res = await ensureFamilyConversation(scopeWith(db));
    expect(res).toEqual({ ok: true, data: { id: 'conv-canonical' } });
    expect(calls.find((c) => c.table === 'rpc:ensure_family_conversation')?.filters)
      .toEqual({ p_family_id: 'fam-1', p_member_id: 'member-1', p_user_id: 'auth-user-1' });
    expect(calls.some((c) => c.table === 'family_conversations')).toBe(false);
    expect(calls.some((c) => c.kind === 'insert' || c.kind === 'update')).toBe(false);
  });

  // Changed by owner decision: this used to assert a refusal ("without a legacy
  // retry"). Without 0475 the previous production lookup now runs instead.
  it('without 0475 opens the oldest un-archived group chat, as before the build-out', async () => {
    const { db, calls } = makeDb((call) => call.table.startsWith('rpc:')
      ? { data: null, error: MISSING('ensure_family_conversation') }
      : call.table === 'family_conversations' ? { data: { id: 'conv-old-group' }, error: null } : successfulReply(call));
    const res = await ensureFamilyConversation(scopeWith(db));
    expect(res).toEqual({ ok: true, data: { id: 'conv-old-group' } });
    expect(calls.filter((c) => c.table.startsWith('rpc:'))).toHaveLength(1);
    expect(calls.find((c) => c.table === 'family_conversations')?.filters).toEqual({ family_id: 'fam-1', kind: 'group', is_archived: false });
    expect(calls.some((c) => c.kind === 'insert')).toBe(false);
  });

  it('without 0475 creates the family group with every member when there is none', async () => {
    const { db, calls } = makeDb((call) => {
      if (call.table.startsWith('rpc:')) return { data: null, error: MISSING('ensure_family_conversation') };
      if (call.table === 'family_members') return { data: 'id' in call.filters ? MEMBERS[0] : MEMBERS, error: null };
      if (call.table === 'family_conversations') return { data: call.kind === 'insert' ? { id: 'conv-new' } : null, error: null };
      return successfulReply(call);
    });
    expect(await ensureFamilyConversation(scopeWith(db))).toEqual({ ok: true, data: { id: 'conv-new' } });
    expect(calls.find((c) => c.table === 'family_conversations' && c.kind === 'insert')?.payload).toEqual({
      family_id: 'fam-1', name: 'Family', kind: 'group', avatar_emoji: '👨‍👩‍👧‍👦',
      member_ids: ['auth-user-1'], participant_ids: ['member-1', 'member-2'], created_by: 'auth-user-1',
    });
  });

  it.each([
    { code: '42501', message: 'permission denied for function ensure_family_conversation' },
    { code: 'PGRST202', message: 'Could not find the function public.ensure_family_conversation_v2(p_family_id) in the schema cache' },
    { code: '42883', message: 'function messaging_private.ensure_family_conversation(uuid) does not exist' },
    { message: 'fetch failed' },
  ])('any other failure of the canonical RPC still fails visibly without a legacy lookup: %j', async (error) => {
    const { db, calls } = makeDb((call) => call.table.startsWith('rpc:') ? { data: null, error } : successfulReply(call));
    expect(await ensureFamilyConversation(scopeWith(db))).toMatchObject({ ok: false, code: 'db' });
    expect(calls.some((c) => c.table === 'family_conversations')).toBe(false);
  });
});

describe('sendFamilyMessage', () => {
  it('carries the exact family and actor to the atomic RPC and keeps shared activity text-free', async () => {
    const { db, calls } = makeDb(successfulReply);
    const res = await sendFamilyMessage(scopeWith(db, { actorKind: 'ai' }), { content: '  Dinner at 6!  ' });
    expect(res.ok).toBe(true);
    expect(calls.find((c) => c.table === 'rpc:send_family_message')?.filters).toEqual({
      p_conversation_id: 'conv-canonical', p_family_id: 'fam-1', p_member_id: 'member-1', p_user_id: 'auth-user-1',
      p_content: 'Dinner at 6!', p_kind: 'text', p_reply_to_id: null, p_idempotency_key: null,
    });
    expect(calls.some((c) => c.table === 'family_messages' && c.kind === 'insert')).toBe(false);
    const activity = calls.filter((c) => ['agent_activity', 'audit_logs'].includes(c.table));
    expect(activity).toHaveLength(2);
    expect(JSON.stringify(activity)).not.toContain('Dinner at 6!');
    expect(calls.find((c) => c.table === 'agent_activity')?.payload).toMatchObject({ title: 'Sent a message' });
  });

  it('carries an explicit null system actor only into the canonical chat', async () => {
    const { db, calls } = makeDb(successfulReply);
    const res = await sendFamilyMessage(scopeWith(db, { userId: null, memberId: null, role: 'system', actorKind: 'system' }), { content: 'Trash day tomorrow' });
    expect(res.ok).toBe(true);
    expect(calls.find((c) => c.table === 'rpc:send_family_message')?.filters).toMatchObject({ p_member_id: null, p_user_id: null, p_conversation_id: 'conv-canonical' });
    expect(calls.some((c) => c.table === 'family_members')).toBe(false);
  });

  it.each([
    { label: 'inactive member', member: { ...MEMBERS[0], is_active: false } },
    { label: 'another user\'s member row', member: { ...MEMBERS[0], user_id: 'someone-else' } },
  ])('refuses $label before opening or writing a chat', async ({ member }) => {
    const { db, calls } = makeDb((call) => call.table === 'family_members' ? { data: member, error: null } : successfulReply(call));
    expect(await sendFamilyMessage(scopeWith(db), { content: 'hello' })).toMatchObject({ ok: false, code: 'denied' });
    expect(calls.map((c) => c.table)).toEqual(['family_members']);
    expect(calls[0].filters).toEqual({ id: 'member-1', family_id: 'fam-1' });
  });

  it.each([
    { userId: null, memberId: null, role: 'parent', actorKind: 'ai' },
    { userId: 'auth-user-1', memberId: null },
  ] as Partial<ServiceScope>[])('refuses an unverified actor before any query: %j', async (extra) => {
    const { db, calls } = makeDb(successfulReply);
    expect(await sendFamilyMessage(scopeWith(db, extra), { content: 'hello' })).toMatchObject({ ok: false, code: 'denied' });
    expect(calls).toHaveLength(0);
  });

  it.each(['parent', 'adult', 'child'] as const)('does not let a %s send into an unrelated private thread', async (role) => {
    const { db, calls } = makeDb((call) => call.table === 'family_conversations'
      ? { data: CONVERSATION({ participant_ids: ['member-other'], member_ids: ['user-other'] }), error: null } : successfulReply(call));
    expect(await sendFamilyMessage(scopeWith(db, { role }), { content: 'hello', conversationId: 'private' })).toMatchObject({ ok: false, code: 'denied' });
    expect(calls.some((c) => c.table.startsWith('rpc:'))).toBe(false);
  });

  it.each([
    { participant_ids: ['member-1'], member_ids: ['user-other'] },
    { participant_ids: ['member-other'], member_ids: ['auth-user-1'] },
    { participant_ids: [], member_ids: [], created_by: 'auth-user-1' },
  ])('preserves each recorded legacy audience or the empty-roster creator: %j', async (roster) => {
    const { db } = makeDb((call) => call.table === 'family_conversations'
      ? { data: CONVERSATION(roster), error: null } : successfulReply(call));
    expect((await sendFamilyMessage(scopeWith(db), { content: 'hello', conversationId: 'conv-1' })).ok).toBe(true);
  });

  it('refuses a null system actor in an existing private thread', async () => {
    const { db, calls } = makeDb(successfulReply);
    expect(await sendFamilyMessage(scopeWith(db, { userId: null, memberId: null, actorKind: 'system', role: 'system' }),
      { content: 'hello', conversationId: 'conv-1' })).toMatchObject({ ok: false, code: 'denied' });
    expect(calls.some((c) => c.table.startsWith('rpc:'))).toBe(false);
  });

  it('refuses an archived conversation without sending', async () => {
    const { db, calls } = makeDb((call) => call.table === 'family_conversations'
      ? { data: CONVERSATION({ is_archived: true }), error: null } : successfulReply(call));
    expect(await sendFamilyMessage(scopeWith(db), { content: 'hello', conversationId: 'conv-1' })).toMatchObject({ ok: false, code: 'denied' });
    expect(calls.some((c) => c.table.startsWith('rpc:'))).toBe(false);
  });

  it('refuses a conversation that is not this family\'s', async () => {
    const { db, calls } = makeDb((call) => call.table === 'family_conversations' ? { data: null, error: null } : successfulReply(call));
    const res = await sendFamilyMessage(scopeWith(db), { content: 'hi', conversationId: 'conv-other' });
    expect(res).toMatchObject({ ok: false, code: 'not_found' });
    expect(calls.find((c) => c.table === 'family_conversations')?.filters).toEqual({ family_id: 'fam-1', id: 'conv-other' });
    expect(calls.some((c) => c.kind === 'insert')).toBe(false);
  });

  it('returns the message a retried run already sent instead of sending again', async () => {
    const { db, calls } = makeDb((call) => {
      if (call.table === 'rpc:find_family_message') return { data: [MESSAGE({ conversation_id: call.filters.p_conversation_id })], error: null };
      return successfulReply(call);
    });
    const res = await sendFamilyMessage(scopeWith(db, { runId: 'run-1', stepId: 'step-2' }), { content: 'Dinner at 6!' });
    expect(res.ok && res.data.id === 'msg-1').toBe(true);
    const probe = calls.find((c) => c.table === 'rpc:find_family_message');
    expect(probe?.filters).toEqual({ p_family_id: 'fam-1', p_conversation_id: 'conv-canonical', p_content: 'Dinner at 6!', p_kind: 'text', p_reply_to_id: null, p_member_id: 'member-1', p_user_id: 'auth-user-1', p_since: '2026-09-05T11:50:00.000Z', p_idempotency_key: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(calls.some((c) => c.table === 'family_messages')).toBe(false);
    expect(calls.some((c) => c.table === 'rpc:send_family_message')).toBe(false);
  });

  it.each(['another-thread', 'deleted-parent'])('rejects an unavailable reply parent (%s) before the send RPC', async (replyToId) => {
    const { db, calls } = makeDb(successfulReply);
    expect(await sendFamilyMessage(scopeWith(db), { content: 'hello', conversationId: 'conv-1', replyToId }))
      .toMatchObject({ ok: false, code: 'not_found' });
    expect(calls.find((c) => c.table === 'family_messages')?.filters)
      .toEqual({ family_id: 'fam-1', conversation_id: 'conv-1', id: replyToId, deleted_at: null });
    expect(calls.some((c) => c.table === 'rpc:send_family_message')).toBe(false);
  });

  it.each([
    { kind: 'text', replyToId: 'reply-2' },
    { kind: 'announcement', replyToId: null },
  ])('does not suppress same-text intent with a different kind or reply: %j', async ({ kind, replyToId }) => {
    const old = MESSAGE({ reply_to_id: 'reply-1' });
    const { db, calls } = makeDb((call) => {
      if (call.table === 'family_messages') return { data: { id: replyToId }, error: null };
      if (call.table === 'rpc:find_family_message') return {
        data: call.filters.p_kind === old.kind && call.filters.p_reply_to_id === old.reply_to_id ? [old] : [], error: null,
      };
      return successfulReply(call);
    });
    expect((await sendFamilyMessage(scopeWith(db, { requestId: 'req-new' }), { content: 'Dinner at 6!', kind, replyToId })).ok).toBe(true);
    expect(calls.filter((c) => c.table === 'rpc:send_family_message')).toHaveLength(1);
  });

  it.each(['42501', 'PGRST202'])('never falls back to a raw retry read when the authorized probe fails (%s)', async (code) => {
    const { db, calls } = makeDb((call) => call.table === 'rpc:find_family_message'
      ? { data: null, error: { code, message: 'Authorized retry probe unavailable' } } : successfulReply(call));
    expect(await sendFamilyMessage(scopeWith(db, { requestId: 'req-probe' }), { content: 'hello', conversationId: 'conv-1' }))
      .toMatchObject({ ok: false, code: 'db' });
    expect(calls.some((c) => c.table === 'family_messages' || c.table === 'rpc:send_family_message')).toBe(false);
  });

  it('treats a zero-row retry result as no match and sends the new intent', async () => {
    const { db, calls } = makeDb((call) => call.table === 'rpc:find_family_message'
      ? { data: [], error: null } : successfulReply(call));
    expect((await sendFamilyMessage(scopeWith(db, { requestId: 'req-new' }), { content: 'hello' })).ok).toBe(true);
    expect(calls.filter((c) => c.table === 'rpc:send_family_message')).toHaveLength(1);
  });

  it('surfaces revocation between the preliminary read and atomic RPC; no insert fallback', async () => {
    const { db, calls } = makeDb((call) => call.table === 'rpc:send_family_message'
      ? { data: null, error: { code: '42501', message: 'An active household member is required' } } : successfulReply(call));
    expect(await sendFamilyMessage(scopeWith(db), { content: 'hello', conversationId: 'conv-1' })).toMatchObject({ ok: false, code: 'db' });
    expect(calls.filter((c) => c.table === 'rpc:send_family_message')).toHaveLength(1);
    expect(calls.some((c) => c.kind === 'insert')).toBe(false);
  });

  // Changed by owner decision: this used to assert that a missing atomic-send
  // RPC is never bypassed. Without 0475 the previous production direct insert
  // now runs; a non-missing error (revocation, above) still never inserts.
  it('without the atomic-send RPC inserts directly, as before the build-out', async () => {
    const { db, calls } = makeDb((call) => {
      if (call.table === 'rpc:send_family_message') return { data: null, error: MISSING('send_family_message') };
      if (call.table === 'family_messages' && call.kind === 'insert') return { data: MESSAGE(), error: null };
      return successfulReply(call);
    });
    const res = await sendFamilyMessage(scopeWith(db), { content: 'hello', conversationId: 'conv-1' });
    expect(res).toMatchObject({ ok: true, data: { id: 'msg-1' } });
    expect(calls.find((c) => c.table === 'family_messages' && c.kind === 'insert')?.payload).toEqual({
      conversation_id: 'conv-1', family_id: 'fam-1', sender_id: 'auth-user-1', sender_name: 'Dana',
      content: 'hello', kind: 'text', reply_to_id: null,
    });
  });

  it('does not insert when the send RPC fails for a reason other than being missing', async () => {
    const { db, calls } = makeDb((call) => call.table === 'rpc:send_family_message'
      ? { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.send_family_message_v2 in the schema cache' } } : successfulReply(call));
    expect(await sendFamilyMessage(scopeWith(db), { content: 'hello', conversationId: 'conv-1' })).toMatchObject({ ok: false, code: 'db' });
    expect(calls.some((c) => c.kind === 'insert')).toBe(false);
  });

  it('without 0475 sends end to end on the previous production path', async () => {
    const sent = MESSAGE({ conversation_id: 'conv-old-group' });
    const { db, calls } = makeDb((call) => {
      if (call.table === 'rpc:ensure_family_conversation') return { data: null, error: MISSING('ensure_family_conversation') };
      if (call.table === 'rpc:find_family_message') return { data: null, error: MISSING('find_family_message') };
      if (call.table === 'rpc:send_family_message') return { data: null, error: MISSING('send_family_message') };
      if (call.table === 'family_conversations') return { data: { id: 'conv-old-group' }, error: null };
      if (call.table === 'family_messages') return { data: call.kind === 'insert' ? sent : null, error: null };
      return successfulReply(call);
    });
    const res = await sendFamilyMessage(scopeWith(db, { requestId: 'req-legacy' }), { content: 'Dinner at 6!' });
    expect(res).toMatchObject({ ok: true, data: { id: 'msg-1', conversation_id: 'conv-old-group' } });
    const probe = calls.find((c) => c.table === 'family_messages' && c.kind === 'select');
    expect(probe?.filters).toEqual({
      family_id: 'fam-1', conversation_id: 'conv-old-group', content: 'Dinner at 6!',
      'gte:created_at': '2026-09-05T11:50:00.000Z', deleted_at: null, sender_id: 'auth-user-1',
    });
    expect(calls.filter((c) => c.table === 'family_messages' && c.kind === 'insert')).toHaveLength(1);
  });

  it('without find_family_message a retried send returns the row the same words already wrote', async () => {
    const { db, calls } = makeDb((call) => {
      if (call.table === 'rpc:find_family_message') return { data: null, error: MISSING('find_family_message') };
      if (call.table === 'family_messages') return { data: MESSAGE({ content: 'hello' }), error: null };
      return successfulReply(call);
    });
    const res = await sendFamilyMessage(scopeWith(db, { requestId: 'req-retry' }), { content: 'hello', conversationId: 'conv-1' });
    expect(res).toMatchObject({ ok: true, data: { id: 'msg-1' } });
    expect(calls.some((c) => c.table === 'rpc:send_family_message' || c.kind === 'insert')).toBe(false);
  });

  it('without is_family_chat a named conversation only has to exist in the family, as before the build-out', async () => {
    let reads = 0;
    const { db, calls } = makeDb((call) => call.table !== 'family_conversations' ? successfulReply(call)
      : ++reads === 1 ? { data: null, error: { code: '42703', message: 'column family_conversations.is_family_chat does not exist' } }
        : { data: { id: 'conv-1' }, error: null });
    const res = await sendFamilyMessage(scopeWith(db), { content: 'hello', conversationId: 'conv-1' });
    expect(res.ok).toBe(true);
    expect(calls.filter((c) => c.table === 'family_conversations').map((c) => c.filters)).toEqual([
      { family_id: 'fam-1', id: 'conv-1' }, { family_id: 'fam-1', id: 'conv-1' },
    ]);
  });

  it('a conversation read that fails for another reason is not retried on the old path', async () => {
    const { db, calls } = makeDb((call) => call.table === 'family_conversations'
      ? { data: null, error: { code: '42703', message: 'column family_conversations.is_archived_at does not exist' } } : successfulReply(call));
    expect(await sendFamilyMessage(scopeWith(db), { content: 'hello', conversationId: 'conv-1' })).toMatchObject({ ok: false, code: 'db' });
    expect(calls.filter((c) => c.table === 'family_conversations')).toHaveLength(1);
    expect(calls.some((c) => c.table.startsWith('rpc:'))).toBe(false);
  });

  it('rejects an empty message before any query', async () => {
    const { db, calls } = makeDb(() => ({ data: null, error: null }));
    expect(await sendFamilyMessage(scopeWith(db), { content: '   ' })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(calls).toHaveLength(0);
  });

  it('surfaces a database failure as ok:false with readable copy', async () => {
    const { db } = makeDb((call) => (call.table === 'family_conversations'
      ? { data: { id: 'conv-1' }, error: null }
      : { data: null, error: { code: '42501', message: 'new row violates row-level security policy' } }));
    const res = await sendFamilyMessage(scopeWith(db), { content: 'hello' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('db');
      expect(res.error).not.toContain('row-level security');
    }
  });
});

describe('createAnnouncement', () => {
  it('sets both author columns from the scope and pins on request', async () => {
    const { db, calls } = makeDb((call) => (call.kind === 'insert'
      ? { data: { id: 'ann-1', family_id: 'fam-1', author_id: 'auth-user-1', author_member_id: 'member-1', title: 'Grandma visits Sunday', body: null, is_pinned: true, created_at: NOW.toISOString(), updated_at: NOW.toISOString() }, error: null }
      : { data: null, error: null }));
    const res = await createAnnouncement(scopeWith(db), { title: ' Grandma visits Sunday ', pinned: true });
    expect(res.ok).toBe(true);
    const insert = calls.find((c) => c.kind === 'insert');
    expect(insert?.table).toBe('family_announcements');
    expect(insert?.payload).toEqual({
      family_id: 'fam-1', title: 'Grandma visits Sunday', body: null, is_pinned: true,
      author_id: 'auth-user-1', author_member_id: 'member-1',
    });
  });

  it('does not post the same headline twice inside a run', async () => {
    const existing = { id: 'ann-1', family_id: 'fam-1', author_id: 'auth-user-1', author_member_id: 'member-1', title: 'Grandma visits Sunday', body: null, is_pinned: false, created_at: NOW.toISOString(), updated_at: NOW.toISOString() };
    const { db, calls } = makeDb(() => ({ data: existing, error: null }));
    const res = await createAnnouncement(scopeWith(db, { requestId: 'req-1' }), { title: 'Grandma visits Sunday' });
    expect(res.ok && res.data.id === 'ann-1').toBe(true);
    expect(calls.some((c) => c.kind === 'insert')).toBe(false);
  });

  it('rejects a missing headline before any query', async () => {
    const { db, calls } = makeDb(() => ({ data: null, error: null }));
    expect(await createAnnouncement(scopeWith(db), { title: '' })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(calls).toHaveLength(0);
  });
});
