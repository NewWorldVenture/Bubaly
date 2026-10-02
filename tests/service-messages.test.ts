// Service clients may bypass RLS. Verify the actor/audience and exact-operation
// retry contract here, independently of the database authorization probes.
import { describe, it, expect } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createAnnouncement, ensureFamilyConversation, sendFamilyMessage } from '@/lib/services/messages';
import type { ServiceScope } from '@/lib/services/types';

type Call = { table: string; kind: string; filters: Record<string, unknown>; payload?: unknown };
type Reply = { data: unknown; error: unknown };
const NOW = new Date('2026-10-02T12:00:00Z');
const MEMBER = { id: 'member-1', family_id: 'fam-1', user_id: 'user-1', display_name: 'Dana', role: 'parent', birthday: null, is_active: true, color: null, avatar_url: null };
const CONV = { id: 'conv-1', family_id: 'fam-1', is_family_chat: false, is_archived: false, member_ids: ['user-1', 'user-2'], participant_ids: ['member-1', 'member-2'] };
const message = (extra: Record<string, unknown> = {}) => ({
  id: 'msg-1', conversation_id: 'conv-1', family_id: 'fam-1', sender_id: 'user-1', sender_name: 'Dana', sender_avatar: null,
  content: 'Dinner at 6!', kind: 'text', attachment_url: null, attachment_name: null, attachment_mime: null, reply_to_id: null,
  reactions: {}, read_by: [], is_pinned: false, deleted_at: null, edited_at: null, idempotency_key: null, created_at: NOW.toISOString(), ...extra,
});

function makeDb(respond: (call: Call) => Reply | undefined = () => undefined) {
  const calls: Call[] = [];
  const reply = (c: Call): Reply => respond(c) ?? {
    data: c.table === 'family_members' ? MEMBER : c.table === 'family_conversations' ? CONV : c.table === 'rpc:ensure_family_conversation' ? 'conv-1' : null, error: null,
  };
  const from = (table: string) => {
    const c: Call = { table, kind: 'select', filters: {} }; calls.push(c);
    const b: Record<string, unknown> = {};
    const chain = () => b;
    const filter = (key: string, value: unknown) => { c.filters[key] = value; return b; };
    Object.assign(b, {
      select: chain, order: chain, limit: chain, eq: filter, is: filter, in: filter,
      gte: (key: string, value: unknown) => filter(`gte:${key}`, value),
      insert: (payload: unknown) => { c.kind = 'insert'; c.payload = payload; return b; },
      single: () => Promise.resolve(reply(c)), maybeSingle: () => Promise.resolve(reply(c)),
      then: (resolve: (value: Reply) => void) => resolve(reply(c)),
    });
    return b;
  };
  const rpc = (name: string, args: Record<string, unknown>) => {
    const c = { table: `rpc:${name}`, kind: 'rpc', filters: args }; calls.push(c); return Promise.resolve(reply(c));
  };
  return { db: { from, rpc } as unknown as SupabaseClient<Database>, calls };
}
function scope(db: SupabaseClient<Database>, extra?: Partial<ServiceScope>): ServiceScope {
  return { db, familyId: 'fam-1', userId: 'user-1', memberId: 'member-1', role: 'parent', actorKind: 'member', tz: 'America/New_York', now: NOW, ...extra };
}
const system = { userId: null, memberId: null, role: 'system', actorKind: 'system' } as const;
const writes = (calls: Call[]) => calls.filter(c => c.table === 'family_messages' && c.kind === 'insert');
const save = (c: Call) => c.table === 'family_messages' && c.kind === 'insert' ? { data: message(c.payload as Record<string, unknown>), error: null } : undefined;

describe('canonical family chat', () => {
  it('uses the atomic operation, never an arbitrary existing group', async () => {
    const { db, calls } = makeDb();
    expect(await ensureFamilyConversation(scope(db))).toEqual({ ok: true, data: { id: 'conv-1' } });
    expect(calls.find(c => c.kind === 'rpc')).toMatchObject({ table: 'rpc:ensure_family_conversation', filters: { p_family_id: 'fam-1' } });
    expect(calls.some(c => c.table === 'family_conversations')).toBe(false);
  });
  it('fails closed when the operation is unavailable', async () => {
    const { db, calls } = makeDb(c => c.kind === 'rpc' ? { data: null, error: { code: 'PGRST202', message: 'RPC missing' } } : undefined);
    expect(await ensureFamilyConversation(scope(db))).toMatchObject({ ok: false, code: 'db' });
    expect(calls.some(c => c.kind === 'insert')).toBe(false);
  });
});

describe('message privacy and attribution', () => {
  it('sends under the active actor identity without putting private text in shared activity', async () => {
    const { db, calls } = makeDb(save);
    expect(await sendFamilyMessage(scope(db, { actorKind: 'ai' }), { content: '  Dinner at 6!  ' })).toMatchObject({ ok: true });
    expect(writes(calls)[0].payload).toEqual({ conversation_id: 'conv-1', family_id: 'fam-1', sender_id: 'user-1', sender_name: 'Dana', content: 'Dinner at 6!', kind: 'text', reply_to_id: null, idempotency_key: null });
    const activity = calls.filter(c => ['audit_logs', 'agent_activity'].includes(c.table));
    expect(activity).toHaveLength(2);
    expect(JSON.stringify(activity)).not.toContain('Dinner at 6!');
    expect(activity.find(c => c.table === 'agent_activity')?.payload).toMatchObject({ title: 'Sent a message', detail: null, href: '/dashboard/messages' });
  });
  it('permits a participant in a private thread and keeps the family filter', async () => {
    const { db, calls } = makeDb(save);
    expect(await sendFamilyMessage(scope(db), { content: 'hello', conversationId: 'conv-1' })).toMatchObject({ ok: true });
    expect(calls.find(c => c.table === 'family_conversations')?.filters).toEqual({ family_id: 'fam-1', id: 'conv-1' });
  });
  it('denies a same-family nonparticipant even for an elevated adult AI actor', async () => {
    const { db, calls } = makeDb(c => c.table === 'family_conversations' ? { data: { ...CONV, member_ids: ['someone-else'], participant_ids: [] }, error: null } : undefined);
    expect(await sendFamilyMessage(scope(db, { actorKind: 'ai' }), { content: 'hi', conversationId: 'private' })).toMatchObject({ ok: false, code: 'denied' });
    expect(writes(calls)).toHaveLength(0);
  });
  it('treats the current participant roster as authoritative over stale user IDs', async () => {
    const { db, calls } = makeDb(c => c.table === 'family_conversations' ? { data: { ...CONV, participant_ids: ['member-2'], member_ids: ['user-1', 'user-2'] }, error: null } : undefined);
    expect(await sendFamilyMessage(scope(db), { content: 'hello', conversationId: 'conv-1' })).toMatchObject({ ok: false, code: 'denied' });
    expect(writes(calls)).toHaveLength(0);
  });
  it('restricts a personless system actor to the canonical household chat', async () => {
    const { db, calls } = makeDb(save);
    expect(await sendFamilyMessage(scope(db, system), { content: 'hi', conversationId: 'private' })).toMatchObject({ ok: false, code: 'denied' });
    expect(writes(calls)).toHaveLength(0);
    expect(await sendFamilyMessage(scope(db, system), { content: 'Trash day tomorrow' })).toMatchObject({ ok: true });
    expect(writes(calls)[0].payload).toMatchObject({ sender_id: null, sender_name: 'Bubaly' });
  });
  for (const changed of [{ is_active: false }, { user_id: 'different-user' }]) {
    it(`rejects invalid membership ${JSON.stringify(changed)}`, async () => {
      const { db, calls } = makeDb(c => c.table === 'family_members' ? { data: { ...MEMBER, ...changed }, error: null } : undefined);
      expect(await sendFamilyMessage(scope(db), { content: 'hi' })).toMatchObject({ ok: false, code: 'denied' });
      expect(writes(calls)).toHaveLength(0);
      expect(calls.some(c => c.kind === 'rpc')).toBe(false);
    });
  }
  it('does not silently turn a missing actor into Bubaly', async () => {
    const { db, calls } = makeDb();
    expect(await sendFamilyMessage(scope(db, { userId: null, memberId: null }), { content: 'hi' })).toMatchObject({ ok: false, code: 'denied' });
    expect(calls).toHaveLength(0);
  });
  it('rejects missing and archived conversations', async () => {
    for (const data of [null, { ...CONV, is_archived: true }]) {
      const { db, calls } = makeDb(c => c.table === 'family_conversations' ? { data, error: null } : undefined);
      expect(await sendFamilyMessage(scope(db), { content: 'hi', conversationId: 'other' })).toMatchObject({ ok: false });
      expect(writes(calls)).toHaveLength(0);
    }
  });
  it('requires a live reply target in the same family and thread', async () => {
    const { db, calls } = makeDb();
    expect(await sendFamilyMessage(scope(db), { content: 'reply', replyToId: 'foreign-message' })).toMatchObject({ ok: false, code: 'not_found' });
    expect(calls.find(c => c.table === 'family_messages')?.filters).toEqual({ family_id: 'fam-1', conversation_id: 'conv-1', id: 'foreign-message', deleted_at: null });
    expect(writes(calls)).toHaveLength(0);
  });
  it('preserves a valid reply on insertion', async () => {
    const { db, calls } = makeDb(c => c.table === 'family_messages' ? save(c) ?? { data: { id: 'parent' }, error: null } : undefined);
    expect(await sendFamilyMessage(scope(db), { content: 'reply', replyToId: 'parent' })).toMatchObject({ ok: true });
    expect(writes(calls)[0].payload).toMatchObject({ reply_to_id: 'parent' });
  });
  it('rejects empty and oversized content before querying', async () => {
    const { db, calls } = makeDb();
    for (const content of ['   ', 'x'.repeat(4001)]) expect(await sendFamilyMessage(scope(db), { content })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(calls).toHaveLength(0);
  });
});

describe('exact operation retries', () => {
  it('deduplicates one operation but accepts identical words in a new operation', async () => {
    const saved = new Map<string, ReturnType<typeof message>>();
    const { db, calls } = makeDb(c => {
      if (c.table !== 'family_messages') return undefined;
      if (c.kind === 'select') return { data: saved.get(String(c.filters.idempotency_key)) ?? null, error: null };
      const row = message(c.payload as Record<string, unknown>); saved.set(String(row.idempotency_key), row); return { data: row, error: null };
    });
    for (const key of ['one', 'one', 'two']) expect(await sendFamilyMessage(scope(db, { idempotencyKey: key }), { content: 'Dinner at 6!' })).toMatchObject({ ok: true });
    expect(writes(calls)).toHaveLength(2);
    expect(calls.find(c => c.table === 'family_messages' && c.kind === 'select')?.filters).toEqual({ family_id: 'fam-1', idempotency_key: 'one', sender_id: 'user-1' });
  });
  it('does not report changed or deleted content under an old key as a new send', async () => {
    for (const changed of [{ content: 'old words' }, { conversation_id: 'elsewhere' }, { reply_to_id: 'old-reply' }, { deleted_at: NOW.toISOString() }]) {
      const { db, calls } = makeDb(c => c.table === 'family_messages' ? { data: message(changed), error: null } : undefined);
      expect(await sendFamilyMessage(scope(db, { idempotencyKey: 'one' }), { content: 'Dinner at 6!' })).toMatchObject({ ok: false, code: 'already_saved' });
      expect(writes(calls)).toHaveLength(0);
    }
  });
  it('surfaces a failed insert instead of pretending success', async () => {
    const { db } = makeDb(c => c.table === 'family_messages' ? { data: null, error: { code: '42501', message: 'new row violates row-level security policy' } } : undefined);
    const result = await sendFamilyMessage(scope(db), { content: 'hi' });
    expect(result).toMatchObject({ ok: false, code: 'db' });
    if (!result.ok) expect(result.error).not.toContain('row-level security');
  });
});

describe('announcements', () => {
  it('sets both author columns and pins on request', async () => {
    const { db, calls } = makeDb(c => c.table === 'family_announcements' && c.kind === 'insert' ? { data: { id: 'ann-1', ...(c.payload as object) }, error: null } : undefined);
    expect(await createAnnouncement(scope(db), { title: ' Grandma visits Sunday ', pinned: true })).toMatchObject({ ok: true });
    expect(calls.find(c => c.table === 'family_announcements' && c.kind === 'insert')?.payload).toEqual({ family_id: 'fam-1', title: 'Grandma visits Sunday', body: null, is_pinned: true, author_id: 'user-1', author_member_id: 'member-1' });
  });
  it('deduplicates a headline inside a run', async () => {
    const { db, calls } = makeDb(c => c.table === 'family_announcements' ? { data: { id: 'ann-1' }, error: null } : undefined);
    expect(await createAnnouncement(scope(db, { requestId: 'req-1' }), { title: 'Grandma visits Sunday' })).toMatchObject({ ok: true, data: { id: 'ann-1' } });
    expect(calls.some(c => c.kind === 'insert')).toBe(false);
  });
  it('rejects a missing headline before querying', async () => {
    const { db, calls } = makeDb();
    expect(await createAnnouncement(scope(db), { title: '' })).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(calls).toHaveLength(0);
  });
});
