// Behavioural tests for the messages service: the family chat is found or
// created once with everyone in it, messages carry the auth user id and the
// sender's real name, announcements set BOTH author columns from the scope,
// and a retried run does not post twice.
import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import {
  createAnnouncement,
  ensureFamilyConversation,
  FAMILY_CONVERSATION_NAME,
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
  return { db: { from } as unknown as SupabaseClient<Database>, calls };
}

const NOW = new Date('2026-09-05T12:00:00Z');

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

describe('ensureFamilyConversation', () => {
  it('reuses the oldest open group chat', async () => {
    const { db, calls } = makeDb(() => ({ data: { id: 'conv-1' }, error: null }));
    const res = await ensureFamilyConversation(scopeWith(db));
    expect(res).toMatchObject({ ok: true, data: { id: 'conv-1', created: false } });
    expect(calls).toHaveLength(1);
    expect(calls[0].filters).toMatchObject({ family_id: 'fam-1', kind: 'group', is_archived: false });
  });

  it('creates the chat with account holders in member_ids and everyone in participant_ids', async () => {
    const { db, calls } = makeDb((call) => {
      if (call.table === 'family_members') return { data: MEMBERS, error: null };
      if (call.kind === 'insert') return { data: { id: 'conv-new' }, error: null };
      return { data: null, error: null };
    });
    const res = await ensureFamilyConversation(scopeWith(db));
    expect(res).toMatchObject({ ok: true, data: { id: 'conv-new', created: true } });
    const insert = calls.find((c) => c.kind === 'insert');
    expect(insert?.table).toBe('family_conversations');
    expect(insert?.payload).toMatchObject({
      family_id: 'fam-1', name: FAMILY_CONVERSATION_NAME, kind: 'group',
      member_ids: ['auth-user-1'], participant_ids: ['member-1', 'member-2'], created_by: 'auth-user-1',
    });
  });
});

describe('sendFamilyMessage', () => {
  it('posts into the family chat with the auth user id and the member\'s display name', async () => {
    const { db, calls } = makeDb((call) => {
      if (call.table === 'family_conversations') return { data: { id: 'conv-1' }, error: null };
      if (call.table === 'family_members') return { data: MEMBERS[0], error: null };
      if (call.table === 'family_messages' && call.kind === 'insert') return { data: MESSAGE(), error: null };
      return { data: null, error: null };
    });
    const res = await sendFamilyMessage(scopeWith(db, { actorKind: 'ai' }), { content: '  Dinner at 6!  ' });
    expect(res.ok).toBe(true);
    const insert = calls.find((c) => c.table === 'family_messages' && c.kind === 'insert');
    expect(insert?.payload).toEqual({
      conversation_id: 'conv-1', family_id: 'fam-1', sender_id: 'auth-user-1', sender_name: 'Dana',
      content: 'Dinner at 6!', kind: 'text', reply_to_id: null,
    });
    expect(calls.find((c) => c.table === 'agent_activity')?.payload).toMatchObject({ agent: 'comms_assistant', href: '/dashboard/messages' });
  });

  it('signs as Bubaly when no person is behind the call', async () => {
    const { db, calls } = makeDb((call) => {
      if (call.table === 'family_conversations') return { data: { id: 'conv-1' }, error: null };
      if (call.table === 'family_messages' && call.kind === 'insert') return { data: MESSAGE({ sender_id: null, sender_name: 'Bubaly' }), error: null };
      return { data: null, error: null };
    });
    const res = await sendFamilyMessage(scopeWith(db, { userId: null, memberId: null, role: 'system', actorKind: 'system' }), { content: 'Trash day tomorrow' });
    expect(res.ok).toBe(true);
    expect(calls.find((c) => c.table === 'family_messages' && c.kind === 'insert')?.payload).toMatchObject({ sender_id: null, sender_name: 'Bubaly' });
  });

  it('refuses a conversation that is not this family\'s', async () => {
    const { db, calls } = makeDb(() => ({ data: null, error: null }));
    const res = await sendFamilyMessage(scopeWith(db), { content: 'hi', conversationId: 'conv-other' });
    expect(res).toMatchObject({ ok: false, code: 'not_found' });
    expect(calls[0].filters).toMatchObject({ family_id: 'fam-1', id: 'conv-other' });
    expect(calls.some((c) => c.kind === 'insert')).toBe(false);
  });

  it('returns the message a retried run already sent instead of sending again', async () => {
    const { db, calls } = makeDb((call) => {
      if (call.table === 'family_conversations') return { data: { id: 'conv-1' }, error: null };
      if (call.table === 'family_messages' && call.kind === 'select') return { data: MESSAGE(), error: null };
      return { data: null, error: null };
    });
    const res = await sendFamilyMessage(scopeWith(db, { runId: 'run-1', stepId: 'step-2' }), { content: 'Dinner at 6!' });
    expect(res.ok && res.data.id === 'msg-1').toBe(true);
    const probe = calls.find((c) => c.table === 'family_messages');
    expect(probe?.filters).toMatchObject({ family_id: 'fam-1', conversation_id: 'conv-1', content: 'Dinner at 6!', sender_id: 'auth-user-1', deleted_at: null });
    expect(calls.some((c) => c.kind === 'insert')).toBe(false);
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
