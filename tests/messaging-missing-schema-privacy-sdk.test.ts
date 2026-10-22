import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { ensureFamilyConversation, sendFamilyMessage } from '@/lib/services/messages';
import type { ServiceScope } from '@/lib/services/types';

const FAMILY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = '11111111-1111-4111-8111-111111111111';
const MEMBER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const CHAT = '44444444-4444-4444-8444-444444444444';
const MESSAGE = '55555555-5555-4555-8555-555555555555';
const NOW = new Date('2026-10-11T13:00:00Z');
const actor = { id: MEMBER, family_id: FAMILY, user_id: USER, display_name: 'Synthetic parent', role: 'parent', birthday: null, is_active: true, color: null, avatar_url: null };
const saved = { id: MESSAGE, family_id: FAMILY, conversation_id: CHAT, sender_id: USER, sender_name: actor.display_name, content: 'PRIVATE_SYNTHETIC_HISTORY', kind: 'text', reply_to_id: null, deleted_at: null, created_at: NOW.toISOString() };
type Mode = 'missing-ensure' | 'missing-column' | 'missing-find' | 'missing-send' | 'permission-refusal' | 'modern';
function fixture(mode: Mode, opts: { joined?: boolean; archived?: boolean; revokeOnRpc?: boolean } = {}) {
  const calls: { destination: string; method: string; query: Record<string, string>; payload?: Record<string, unknown> }[] = [];
  const errors: string[] = [];
  let active = true;
  const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  const missing = (name: string) => reply({ code: 'PGRST202', message: `Could not find the function public.${name} in the schema cache`, details: null, hint: null }, 404);
  const fetch: typeof globalThis.fetch = async (input, init) => {
    try {
      const req = new Request(input, init);
      const url = new URL(req.url);
      if (url.origin !== 'https://messaging-privacy.invalid' || !url.pathname.startsWith('/rest/v1/')) throw new Error('Unexpected synthetic destination');
      const destination = url.pathname.slice('/rest/v1/'.length);
      const payload = req.method === 'POST' ? await req.json() as Record<string, unknown> : undefined;
      calls.push({ destination, method: req.method, query: Object.fromEntries(url.searchParams), payload });
      if (destination === 'family_members') {
        expect(req.method).toBe('GET');
        expect(url.searchParams.get('family_id')).toBe('eq.' + FAMILY);
        expect(url.searchParams.get('id')).toBe('eq.' + MEMBER);
        return reply([{ ...actor, is_active: active }]);
      }
      if (destination === 'family_conversations') {
        expect(req.method).toBe('GET');
        expect(url.searchParams.get('family_id')).toBe('eq.' + FAMILY);
        if (url.searchParams.get('select')?.includes('is_family_chat') && mode === 'missing-column') {
          return reply({ code: '42703', message: 'column family_conversations.is_family_chat does not exist' }, 400);
        }
        if (url.searchParams.get('select') === 'id') return reply([{ id: CHAT }]);
        return reply([{ id: CHAT, is_family_chat: false, is_archived: opts.archived ?? false, participant_ids: opts.joined === false ? [OTHER] : [MEMBER], member_ids: opts.joined === false ? [OTHER] : [USER], created_by: OTHER }]);
      }
      if (destination.startsWith('rpc/')) {
        const rpc = destination.slice(4);
        expect(payload?.p_family_id).toBe(FAMILY);
        expect(payload?.p_member_id).toBe(MEMBER);
        expect(payload?.p_user_id).toBe(USER);
        if (opts.revokeOnRpc) active = false;
        if (mode === 'permission-refusal') return reply({ code: '42501', message: 'Synthetic actor permission refused' }, 403);
        if (rpc === 'ensure_family_conversation') return mode === 'missing-ensure' ? missing(rpc) : reply(CHAT);
        if (rpc === 'find_family_message') return mode === 'missing-find' ? missing(rpc) : reply([]);
        if (rpc === 'send_family_message') return mode === 'missing-send' || mode === 'missing-column' ? missing(rpc) : reply({ ...saved, content: payload?.p_content });
        throw new Error('Unexpected synthetic RPC');
      }
      if (destination === 'family_messages') {
        expect(url.searchParams.get('family_id') ?? payload?.family_id).toBe(req.method === 'GET' ? 'eq.' + FAMILY : FAMILY);
        if (req.method === 'GET') return reply([saved]);
        if (req.method === 'POST') return reply({ ...saved, ...payload }, 201);
      }
      if (destination === 'audit_logs' && req.method === 'POST') {
        expect(payload?.family_id).toBe(FAMILY);
        expect(payload?.actor_id).toBe(USER);
        return new Response(null, { status: 204 });
      }
      throw new Error('Unexpected synthetic request ' + destination);
    } catch (error) {
      errors.push(String(error));
      throw error;
    }
  };
  const db = createClient<Database>('https://messaging-privacy.invalid', 'synthetic-service-only', { accessToken: async () => null, global: { fetch } });
  const scope = (extra: Partial<ServiceScope> = {}): ServiceScope => ({ db, familyId: FAMILY, userId: USER, memberId: MEMBER, role: 'parent', actorKind: 'member', tz: 'UTC', now: NOW, ...extra });
  return { calls, errors, scope, active: () => active };
}
function observe(name: string, f: ReturnType<typeof fixture>, result: unknown) {
  expect(f.errors).toEqual([]);
  const output = process.env.PRIVACY_OBSERVATIONS;
  if (output) fs.appendFileSync(output, JSON.stringify({ name, active: f.active(), calls: f.calls, result }) + '\n');
}
describe('current missing-0475 service paths preserve explicit access and atomic guarantees', () => {
  it('does not adopt an existing private group as the canonical empty Family Chat when its RPC is missing', async () => {
    const f = fixture('missing-ensure', { joined: false });
    const result = await ensureFamilyConversation(f.scope());
    observe('old-group-adoption', f, result);
    expect(result.ok).toBe(false);
    expect(f.calls.some(c => c.destination === 'family_conversations')).toBe(false);
  });
  it('does not send into a legacy conversation outside the original participant audience when marker and atomic RPC are missing', async () => {
    const f = fixture('missing-column', { joined: false });
    const result = await sendFamilyMessage(f.scope(), { conversationId: CHAT, content: 'Synthetic new message' });
    observe('nonparticipant-legacy-send', f, result);
    expect(result.ok).toBe(false);
    expect(f.calls.some(c => c.destination === 'family_messages' && c.method === 'POST')).toBe(false);
  });
  it('does not return old private history after actor removal at a missing atomic duplicate RPC', async () => {
    const f = fixture('missing-find', { revokeOnRpc: true });
    const result = await sendFamilyMessage(f.scope({ idempotencyKey: 'synthetic-retry' }), { conversationId: CHAT, content: saved.content });
    observe('revoked-legacy-duplicate-history', f, result);
    expect(f.active()).toBe(false);
    expect(result.ok).toBe(false);
    expect(f.calls.some(c => c.destination === 'family_messages')).toBe(false);
  });
  it('does not raw-insert after actor removal at a missing atomic send RPC', async () => {
    const f = fixture('missing-send', { revokeOnRpc: true });
    const result = await sendFamilyMessage(f.scope(), { conversationId: CHAT, content: 'Synthetic new message' });
    observe('revoked-legacy-send', f, result);
    expect(f.active()).toBe(false);
    expect(result.ok).toBe(false);
    expect(f.calls.some(c => c.destination === 'family_messages' && c.method === 'POST')).toBe(false);
  });
  it('does not send into an archived old conversation when its family-chat marker is missing', async () => {
    const f = fixture('missing-column', { joined: true, archived: true });
    const result = await sendFamilyMessage(f.scope(), { conversationId: CHAT, content: 'Synthetic new message' });
    observe('archived-legacy-send', f, result);
    expect(result.ok).toBe(false);
    expect(f.calls.some(c => c.destination === 'family_messages' && c.method === 'POST')).toBe(false);
  });
  it('preserves refusal of a non-missing actor permission error without raw fallback', async () => {
    const f = fixture('permission-refusal');
    const result = await ensureFamilyConversation(f.scope());
    observe('permission-refusal-control', f, result);
    expect(result).toMatchObject({ ok: false, code: 'db' });
    expect(f.calls.map(c => c.destination)).toEqual(['family_members', 'rpc/ensure_family_conversation']);
  });
  it('preserves a healthy atomic canonical chat result without reading an old group', async () => {
    const f = fixture('modern');
    const result = await ensureFamilyConversation(f.scope());
    observe('atomic-chat-healthy-control', f, result);
    expect(result).toMatchObject({ ok: true, data: { id: CHAT } });
    expect(f.calls.map(c => c.destination)).toEqual(['family_members', 'rpc/ensure_family_conversation']);
  });
  it('preserves modern participant exclusion before any atomic send', async () => {
    const f = fixture('modern', { joined: false });
    const result = await sendFamilyMessage(f.scope(), { conversationId: CHAT, content: 'Synthetic new message' });
    observe('modern-nonparticipant-control', f, result);
    expect(result).toMatchObject({ ok: false, code: 'denied' });
    expect(f.calls.map(c => c.destination)).toEqual(['family_members', 'family_conversations']);
  });
  it('preserves a healthy joined atomic send and author identity', async () => {
    const f = fixture('modern');
    const result = await sendFamilyMessage(f.scope(), { conversationId: CHAT, content: 'Synthetic new message' });
    observe('atomic-send-healthy-control', f, result);
    expect(result).toMatchObject({ ok: true, data: { family_id: FAMILY, sender_id: USER, content: 'Synthetic new message' } });
    expect(f.calls.map(c => c.destination)).toEqual(['family_members', 'family_conversations', 'rpc/send_family_message', 'audit_logs']);
  });
});
