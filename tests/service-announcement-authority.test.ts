// Actual installed Supabase/PostgREST client with an entirely intercepted,
// synthetic transport. These service-boundary controls do not execute RLS or
// demonstrate transaction-atomic revocation after the final membership read.
import { describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createAnnouncement } from '@/lib/services/messages';
import type { ServiceScope } from '@/lib/services/types';

type Row = Record<string, unknown>;
type ReadMode = { row?: Row | null; status?: number; raw?: unknown; throws?: boolean };
const NOW = new Date('2026-10-09T18:00:00.000Z');
const MEMBER: Row = {
  id: 'member-1', family_id: 'family-1', user_id: 'user-1', is_active: true,
  role: 'parent', display_name: 'Synthetic Parent', birthday: null, color: null, avatar_url: null,
};
const STORED: Row = {
  id: 'announcement-1', family_id: 'family-1', author_id: 'user-1', author_member_id: 'member-1',
  title: 'Synthetic update', body: 'Private synthetic history', is_pinned: false,
  created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
};
function fixture(mode: ReadMode = {}, scopeExtra: Partial<ServiceScope> = {}, duplicate = false) {
  const calls: { table: string; method: string; query: URLSearchParams; body: unknown }[] = [];
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });
  const db = createClient<Database>('https://announcement.synthetic.invalid', 'synthetic-service-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input, init) => {
      const request = new Request(input, init), url = new URL(request.url);
      if (url.origin !== 'https://announcement.synthetic.invalid') throw new Error('Unexpected network refused');
      const table = url.pathname.split('/').at(-1)!;
      const body = request.method === 'POST' ? await request.json() : null;
      calls.push({ table, method: request.method, query: url.searchParams, body });
      if (table === 'family_members' && request.method === 'GET') {
        if (mode.throws) throw new Error('Synthetic membership transport refused');
        if (mode.status) return reply({ code: '42501', message: 'Synthetic membership refused' }, mode.status);
        if ('raw' in mode) return reply(mode.raw);
        const row = 'row' in mode ? mode.row : MEMBER;
        // Model a real family/id-scoped result; malformed controls separately
        // return the impossible body explicitly to test fail-closed admission.
        const visible = row && row.id === url.searchParams.get('id')?.slice(3)
          && row.family_id === url.searchParams.get('family_id')?.slice(3);
        return reply(visible ? [row] : []);
      }
      if (table === 'family_announcements' && request.method === 'GET') return reply(duplicate ? [STORED] : []);
      if (table === 'family_announcements' && request.method === 'POST') return reply({ ...STORED, ...(body as Row) }, 201);
      if (table === 'audit_logs' && request.method === 'POST') return reply(null, 201);
      if (table === 'agent_activity' && request.method === 'POST') return reply({ id: 'activity-1' }, 201);
      throw new Error(`Unexpected synthetic request ${request.method} ${table}`);
    } },
  });
  const scope: ServiceScope = {
    db, familyId: 'family-1', userId: 'user-1', memberId: 'member-1', role: 'parent',
    actorKind: 'ai', tz: 'America/New_York', now: NOW, ...scopeExtra,
  };
  return { calls, scope };
}
const refused = [
  ['removed actor', { row: null }],
  ['inactive actor', { row: { ...MEMBER, is_active: false } }],
  ['reassigned to another family', { row: { ...MEMBER, family_id: 'family-2' } }],
  ['reassigned to another user', { row: { ...MEMBER, user_id: 'user-2' } }],
  ['lost login', { row: { ...MEMBER, user_id: null } }],
  ['cached parent now child', { row: { ...MEMBER, role: 'child' } }],
  ['cached parent now teen', { row: { ...MEMBER, role: 'teen' } }],
  ['cached parent now caregiver', { row: { ...MEMBER, role: 'caregiver' } }],
  ['cached parent now guest', { row: { ...MEMBER, role: 'guest' } }],
  ['membership read refused', { status: 403 }],
  ['membership transport failed', { throws: true }],
  ['missing current active flag', { raw: [{ ...MEMBER, is_active: undefined }] }],
  ['truthy numeric active flag', { raw: [{ ...MEMBER, is_active: 1 }] }],
  ['truthy text active flag', { raw: [{ ...MEMBER, is_active: 'true' }] }],
  ['wrong returned member', { raw: [{ ...MEMBER, id: 'member-2' }] }],
  ['wrong returned family', { raw: [{ ...MEMBER, family_id: 'family-2' }] }],
  ['unknown current role', { raw: [{ ...MEMBER, role: 'owner' }] }],
  ['missing current role', { raw: [{ ...MEMBER, role: undefined }] }],
  ['object current role', { raw: [{ ...MEMBER, role: {} }] }],
  ['cached parent now adult', { row: { ...MEMBER, role: 'adult' } }],
  ['multiple returned members', { raw: [MEMBER, MEMBER] }],
] satisfies [string, ReadMode][];

describe('announcement current actor authority with installed SDK', () => {
  for (const keyed of [false, true]) {
    it.each(refused)('%s refuses '+(keyed ? 'keyed history before its duplicate probe' : 'a new post'), async (_name, mode) => {
      const { calls, scope } = fixture(mode, keyed ? { requestId: 'request-1' } : {}, keyed);
      const result = await createAnnouncement(scope, { title: 'Synthetic update', body: 'New synthetic body' });
      expect(result.ok).toBe(false);
      expect(calls.filter(call => call.table === 'family_announcements')).toHaveLength(0);
      expect(calls.filter(call => ['audit_logs', 'agent_activity'].includes(call.table))).toHaveLength(0);
    });
  }

  it.each(['parent', 'adult', 'teen', 'child', 'caregiver', 'guest'] as const)('unchanged %s service scope preserves caller-owned role admission', async role => {
    const { calls, scope } = fixture({ row: { ...MEMBER, role } }, { role });
    const result = await createAnnouncement(scope, { title: ' Synthetic update ', body: ' Details ', pinned: true });
    expect(result.ok).toBe(true);
    const inserts = calls.filter(call => call.table === 'family_announcements' && call.method === 'POST');
    expect(inserts).toHaveLength(1);
    expect(inserts[0].body).toEqual({ family_id: 'family-1', title: 'Synthetic update', body: 'Details', is_pinned: true, author_id: 'user-1', author_member_id: 'member-1' });
    const actorRead = calls.find(call => call.table === 'family_members');
    expect(actorRead?.query.get('id')).toBe('eq.member-1');
    expect(actorRead?.query.get('family_id')).toBe('eq.family-1');
    expect(calls.map(call => call.table)).toEqual(['family_members', 'family_announcements', 'audit_logs', 'agent_activity']);
  });

  it('an active unchanged actor retains keyed history without a duplicate insert or new activity', async () => {
    const { calls, scope } = fixture({}, { requestId: 'request-1' }, true);
    const result = await createAnnouncement(scope, { title: 'Synthetic update' });
    expect(result).toMatchObject({ ok: true, data: STORED });
    expect(calls.map(call => call.table)).toEqual(['family_members', 'family_announcements']);
    expect(calls[1].query.get('family_id')).toBe('eq.family-1');
    expect(calls[1].query.get('title')).toBe('eq.Synthetic update');
    expect(calls[1].query.get('created_at')).toBe('gte.2026-10-08T18:00:00.000Z');
    expect(calls.every(call => call.method === 'GET')).toBe(true);
  });

  it('a legitimate singular-object membership reply keeps the unchanged actor', async () => {
    const { calls, scope } = fixture({ raw: MEMBER });
    expect(await createAnnouncement(scope, { title: 'Synthetic update' })).toMatchObject({ ok: true });
    expect(calls.filter(call => call.table === 'family_announcements' && call.method === 'POST')).toHaveLength(1);
  });

  it.each(['child', 'guest'] as const)('cached %s upgraded to parent also requires a fresh scope', async role => {
    const { calls, scope } = fixture({}, { role });
    expect(await createAnnouncement(scope, { title: 'Synthetic update' })).toMatchObject({ ok: false, code: 'denied' });
    expect(calls.map(call => call.table)).toEqual(['family_members']);
  });

  it('explicit ownerless system preserves its established attribution contract', async () => {
    const { calls, scope } = fixture({}, { userId: null, memberId: null, role: 'system', actorKind: 'system' });
    const result = await createAnnouncement(scope, { title: 'Synthetic system update' });
    expect(result.ok).toBe(true);
    expect(calls.some(call => call.table === 'family_members')).toBe(false);
    expect(calls.find(call => call.table === 'family_announcements')?.body).toMatchObject({ author_id: null, author_member_id: null });
  });

  it.each([
    { userId: null }, { memberId: null }, { userId: null, memberId: null },
    { userId: null, memberId: null, role: 'system' as const },
    { userId: null, memberId: null, actorKind: 'system' as const },
    { userId: null, memberId: 'member-1', actorKind: 'system' as const, role: 'system' as const },
  ])('partial or forged system identity refuses before any query: %j', async extra => {
    const { calls, scope } = fixture({}, extra);
    expect(await createAnnouncement(scope, { title: 'Synthetic update' })).toMatchObject({ ok: false, code: 'denied' });
    expect(calls).toHaveLength(0);
  });

  it.each([
    { title: '' }, { title: ' '.repeat(10) }, { title: 'x'.repeat(201) },
    { title: 'valid', body: 'x'.repeat(4001) },
  ])('invalid content refuses before the actor lookup: %j', async input => {
    const { calls, scope } = fixture({ status: 403 });
    expect(await createAnnouncement(scope, input)).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(calls).toHaveLength(0);
  });
});

it('an unknown role does not become valid just because a malformed scope matches it', async () => {
  const { calls, scope } = fixture({ raw: [{ ...MEMBER, role: 'owner' }] }, { role: 'owner' as ServiceScope['role'] });
  expect(await createAnnouncement(scope, { title: 'Synthetic update' })).toMatchObject({ ok: false, code: 'denied' });
  expect(calls.map(call => call.table)).toEqual(['family_members']);
});
