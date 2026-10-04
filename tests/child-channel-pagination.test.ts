import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { childrenBlockedOn } from '@/lib/notifications/child-channels';

type Member = { id: string; user_id: string | null; family_id: string; role: string; is_active: boolean };
type Setting = { family_id: string; child_channels: unknown };
type Table = 'family_members' | 'family_ai_settings';
type Call = { table: Table; ids: string[]; offset: number; limit: number | null; order: string | null; url: string; count: number | null };
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const member = (n: number, overrides: Partial<Member> = {}): Member => ({
  id: id(n), user_id: id(10000 + n), family_id: id(20000), role: 'child', is_active: true, ...overrides,
});

// The actual SDK and shared paging/chunk helpers execute. Only its read-only
// transport is synthetic; the native network seal must stay intact.
function fixture(members: Member[], settings: Setting[], options: {
  memberCap?: number; settingsCap?: number;
  fail?: { table: Table; offset: number; wantedId?: string; mode?: 'error' | 'throw' | 'null' };
} = {}) {
  const calls: Call[] = [];
  const db = createClient<Database>('https://synthetic.invalid', 'synthetic-not-a-provider-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.origin !== 'https://synthetic.invalid' || (init?.method ?? 'GET') !== 'GET') throw new Error('Unexpected transport');
      const table = url.pathname.split('/').at(-1) as Table;
      if (!['family_members', 'family_ai_settings'].includes(table)) throw new Error('Unexpected table');
      const query = url.searchParams;
      const filter = table === 'family_members' ? 'user_id' : 'family_id';
      const ids = /^in\.\((.*)\)$/.exec(query.get(filter) ?? '')?.[1].split(',');
      if (!ids) throw new Error('Missing ID filter');
      if (table === 'family_members' && (query.get('role') !== 'eq.child' || query.get('is_active') !== 'eq.true')) throw new Error('Missing child membership scope');
      const columns = query.get('select')?.split(',');
      const expected = table === 'family_members' ? ['user_id', 'family_id'] : ['family_id', 'child_channels'];
      if (JSON.stringify(columns) !== JSON.stringify(expected)) throw new Error('Unexpected projection');
      const offset = Number(query.get('offset') ?? 0);
      const limit = query.has('limit') ? Number(query.get('limit')) : null;
      const order = query.get('order');
      const call: Call = { table, ids, offset, limit, order, url: url.href, count: null };
      calls.push(call);
      const failure = options.fail;
      const headers = { 'content-type': 'application/json' };
      if (failure?.table === table && failure.offset === offset && (!failure.wantedId || ids.includes(failure.wantedId))) {
        if (failure.mode === 'throw') throw new Error('Synthetic rejected read');
        if (failure.mode === 'null') return new Response('null', { status: 200, headers });
        return new Response(JSON.stringify({ code: '57014', message: 'Synthetic read failure' }), { status: 500, headers });
      }
      let rows: Record<string, unknown>[] = table === 'family_members'
        ? members.filter(row => row.user_id && ids.includes(row.user_id) && row.role === 'child' && row.is_active)
        : settings.filter(row => ids.includes(row.family_id));
      if (order) {
        const key = order.split('.')[0];
        rows = [...rows].sort((a, b) => String(a[key]).localeCompare(String(b[key])));
      }
      const cap = table === 'family_members' ? options.memberCap ?? 1000 : options.settingsCap ?? 1000;
      rows = rows.slice(offset, offset + Math.min(limit ?? cap, cap));
      call.count = rows.length;
      const data = rows.map(row => Object.fromEntries(expected.map(column => [column, row[column]])));
      return new Response(JSON.stringify(data), { status: 200, headers });
    } },
  });
  return { db, calls };
}

afterEach(() => vi.restoreAllMocks());

describe('complete child-channel policy through the actual SDK', () => {
  it.each(['push', 'email'] as const)('finds a later blocked child after a one-row membership cap for %s', async channel => {
    const members = [member(1), member(2)];
    const f = fixture(members, [{ family_id: id(20000), child_channels: { [channel]: false } }], { memberCap: 1 });
    expect(await childrenBlockedOn(f.db, channel, members.map(row => row.user_id!))).toEqual(new Set(members.map(row => row.user_id!)));
    expect(f.calls.filter(call => call.table === 'family_members').map(call => [call.offset, call.count])).toEqual([[0, 1], [1, 1], [2, 0]]);
  });

  it('chunks 1001 recipient IDs and still blocks the last child', async () => {
    const members = Array.from({ length: 1001 }, (_, n) => member(n + 1));
    const f = fixture(members, [{ family_id: id(20000), child_channels: { push: false } }]);
    const blocked = await childrenBlockedOn(f.db, 'push', members.map(row => row.user_id!));
    expect(blocked.size).toBe(1001);
    expect(blocked.has(members.at(-1)!.user_id!)).toBe(true);
    const firstPages = f.calls.filter(call => call.table === 'family_members' && call.offset === 0);
    expect(firstPages.map(call => call.ids.length)).toEqual([...Array(10).fill(100), 1]);
    expect(f.calls.every(call => call.ids.length <= 100 && call.url.length < 8000)).toBe(true);
  });

  it('pages more than 1000 memberships for one user and retains any-family blocking', async () => {
    const members = Array.from({ length: 1001 }, (_, n) => member(n + 1, { user_id: id(10001), family_id: id(20001 + n) }));
    const lastFamily = members.at(-1)!.family_id;
    const f = fixture(members, [{ family_id: lastFamily, child_channels: { email: false } }]);
    expect(await childrenBlockedOn(f.db, 'email', [id(10001)])).toEqual(new Set([id(10001)]));
    expect(f.calls.filter(call => call.table === 'family_members').map(call => [call.offset, call.count])).toEqual([[0, 1000], [1000, 1], [1001, 0]]);
    expect(f.calls.filter(call => call.table === 'family_ai_settings' && call.offset === 0)).toHaveLength(11);
  });

  it.each(['push', 'email'] as const)('finds later family settings after a one-row settings cap for %s', async channel => {
    const members = [member(1, { family_id: id(20001) }), member(2, { family_id: id(20002) })];
    const f = fixture(members, [
      { family_id: id(20001), child_channels: { [channel]: true } },
      { family_id: id(20002), child_channels: { [channel]: false } },
    ], { settingsCap: 1 });
    expect(await childrenBlockedOn(f.db, channel, members.map(row => row.user_id!))).toEqual(new Set([members[1].user_id!]));
    expect(f.calls.filter(call => call.table === 'family_ai_settings').map(call => [call.offset, call.count])).toEqual([[0, 1], [1, 1], [2, 0]]);
  });

  it('chunks and pages settings across many families without losing the blocked tail', async () => {
    const members = Array.from({ length: 151 }, (_, n) => member(n + 1, { family_id: id(20001 + n) }));
    const settings = members.map((row, n) => ({ family_id: row.family_id, child_channels: { push: n !== 150 } }));
    const f = fixture(members, settings, { settingsCap: 40 });
    expect(await childrenBlockedOn(f.db, 'push', members.map(row => row.user_id!))).toEqual(new Set([members.at(-1)!.user_id!]));
    expect(f.calls.filter(call => call.table === 'family_ai_settings' && call.offset === 0).map(call => call.ids.length)).toEqual([100, 51]);
    expect(f.calls.filter(call => call.table === 'family_ai_settings' && call.ids.length === 100).map(call => [call.offset, call.count])).toEqual([[0, 40], [40, 40], [80, 20], [100, 0]]);
  });

  it('orders memberships by unique member ID and settings by unique family ID with bounded ranges', async () => {
    const f = fixture([member(2), member(1)], [{ family_id: id(20000), child_channels: { push: false } }], { memberCap: 1 });
    await childrenBlockedOn(f.db, 'push', [id(10001), id(10002)]);
    expect(f.calls.every(call => call.order === (call.table === 'family_members' ? 'id.asc' : 'family_id.asc') && call.limit === 1000)).toBe(true);
    expect(f.calls.filter(call => call.table === 'family_ai_settings').map(call => call.count)).toEqual([1, 0]);
  });

  it.each(['family_members', 'family_ai_settings'] as const)('rejects a later %s page instead of allowing a partial policy set', async table => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const members = [member(1, { family_id: id(20001) }), member(2, { family_id: id(20002) })];
    const settings = members.map(row => ({ family_id: row.family_id, child_channels: { push: false } }));
    const f = fixture(members, settings, { memberCap: 1, settingsCap: 1, fail: { table, offset: 1 } });
    await expect(childrenBlockedOn(f.db, 'push', members.map(row => row.user_id!))).rejects.toThrow(table === 'family_members' ? 'Child channel membership read failed.' : 'Child channel settings read failed.');
    if (table === 'family_members') expect(f.calls.some(call => call.table === 'family_ai_settings')).toBe(false);
  });

  it.each(['family_members', 'family_ai_settings'] as const)('rejects a failed later %s ID chunk before returning any allowed set', async table => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const members = Array.from({ length: 101 }, (_, n) => member(n + 1, { family_id: id(20001 + n) }));
    const settings = members.map(row => ({ family_id: row.family_id, child_channels: { email: false } }));
    const tail = members.at(-1)!;
    const f = fixture(members, settings, { fail: { table, offset: 0, wantedId: table === 'family_members' ? tail.user_id! : tail.family_id } });
    await expect(childrenBlockedOn(f.db, 'email', members.map(row => row.user_id!))).rejects.toThrow(table === 'family_members' ? 'Child channel membership read failed.' : 'Child channel settings read failed.');
  });

  it.each([
    { table: 'family_members' as const, mode: 'throw' as const },
    { table: 'family_ai_settings' as const, mode: 'throw' as const },
    { table: 'family_members' as const, mode: 'null' as const },
    { table: 'family_ai_settings' as const, mode: 'null' as const },
  ])('rejects an unavailable $table page ($mode)', async ({ table, mode }) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = fixture([member(1)], [{ family_id: id(20000), child_channels: { push: false } }], { fail: { table, offset: 0, mode } });
    await expect(childrenBlockedOn(f.db, 'push', [id(10001)])).rejects.toThrow(table === 'family_members' ? 'Child channel membership read failed.' : 'Child channel settings read failed.');
  });

  it('retains user-global blocking if any active child family disables the channel', async () => {
    const members = [member(1), member(2, { user_id: id(10001), family_id: id(20002) })];
    const f = fixture(members, [{ family_id: id(20000), child_channels: { push: true } }, { family_id: id(20002), child_channels: { push: false } }], { memberCap: 1, settingsCap: 1 });
    expect(await childrenBlockedOn(f.db, 'push', [id(10001)])).toEqual(new Set([id(10001)]));
  });

  it.each(['teen', 'parent', 'guest'])('does not apply child policy to the %s role', async role => {
    const f = fixture([member(1, { role })], [{ family_id: id(20000), child_channels: { push: false, email: false } }]);
    expect(await childrenBlockedOn(f.db, 'push', [id(10001)])).toEqual(new Set());
    expect(f.calls.map(call => call.table)).toEqual(['family_members']);
  });

  it('ignores inactive child membership', async () => {
    const f = fixture([member(1, { is_active: false })], [{ family_id: id(20000), child_channels: { email: false } }]);
    expect(await childrenBlockedOn(f.db, 'email', [id(10001)])).toEqual(new Set());
  });

  it.each([{}, { push: true }, { push: 'false' }, { push: 0 }, null, [], 'invalid'])('retains absent-or-nonfalse permission semantics for %j', async child_channels => {
    const f = fixture([member(1)], [{ family_id: id(20000), child_channels }]);
    expect(await childrenBlockedOn(f.db, 'push', [id(10001)])).toEqual(new Set());
  });

  it('keeps missing settings allowed and does not confuse the other channel', async () => {
    const absent = fixture([member(1)], []);
    expect(await childrenBlockedOn(absent.db, 'push', [id(10001)])).toEqual(new Set());
    const otherChannel = fixture([member(1)], [{ family_id: id(20000), child_channels: { email: false } }]);
    expect(await childrenBlockedOn(otherChannel.db, 'push', [id(10001)])).toEqual(new Set());
  });

  it('deduplicates recipient IDs and performs no reads for an empty request', async () => {
    const f = fixture([member(1)], [{ family_id: id(20000), child_channels: { push: false } }]);
    expect(await childrenBlockedOn(f.db, 'push', ['', id(10001), id(10001)])).toEqual(new Set([id(10001)]));
    expect(f.calls.filter(call => call.table === 'family_members').every(call => call.ids.length === 1)).toBe(true);
    const empty = fixture([], []);
    expect(await childrenBlockedOn(empty.db, 'push', [])).toEqual(new Set());
    expect(empty.calls).toEqual([]);
  });
});
