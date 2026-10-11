import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { dispatchPendingPushes, sendPushToUser } from '@/lib/server/push';
import type { Database } from '@/lib/database.types';
import { at } from './helpers/source-order';

// Real installed SDK and dispatcher. Finite synthetic REST relationships and
// inert device providers do not establish SQL/RLS or atomic provider admission.
const transport = vi.hoisted(() => ({ endpoint: vi.fn(), web: vi.fn(), native: vi.fn() }));
vi.mock('@/lib/server/push-endpoint', () => ({ isDeliverablePushEndpoint: transport.endpoint }));
vi.mock('web-push', () => ({ default: { setVapidDetails: vi.fn(), sendNotification: transport.web } }));
vi.mock('@/lib/server/native-push', () => ({ sendNativePush: transport.native, nativePushConfigured: () => ({ fcm: true, apns: true }) }));
const NOW = new Date('2026-10-11T15:00:00Z');
const FAMILY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FOREIGN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER = '11111111-1111-4111-8111-111111111111';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
type Row = Record<string, unknown>;
function fixture(options: { broadcast?: boolean; devices?: number; old?: boolean; closed?: boolean; finalReply?: unknown; finalStatus?: number } = {}) {
  const tables: Record<string, Row[]> = {
    families: [{ id: FAMILY, closed_at: options.closed ? NOW.toISOString() : null }],
    family_members: [{ id: uuid(10), family_id: FAMILY, user_id: USER, is_active: true, role: 'parent' }],
    notifications: [{ id: uuid(1), family_id: FAMILY, user_id: options.broadcast ? null : USER, title: 'Synthetic private family reminder', body: 'Synthetic only', related_type: null, related_id: null, send_at: NOW.toISOString(), created_at: options.old ? '2026-10-01T15:00:00Z' : NOW.toISOString(), pushed_at: null }],
    push_devices: Array.from({ length: options.devices ?? 1 }, (_, i) => ({ id: uuid(100 + i), user_id: USER, provider: 'webpush', platform: 'web', enabled: true, endpoint: `https://push-device.example.test/${i}`, p256dh: 'synthetic-public', auth: 'synthetic-auth' })),
    family_ai_settings: [], user_preferences: [], push_deliveries: [], app_settings: [],
  };
  const calls: { table: string; method: string; query: Record<string, string> }[] = [], events: string[] = [], errors: string[] = [];
  const split = (text: string) => { const parts: string[] = []; let depth = 0, start = 0; for (let i = 0; i < text.length; i++) { if (text[i] === '(') depth++; if (text[i] === ')') depth--; if (text[i] === ',' && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; } } parts.push(text.slice(start)); return parts; };
  const familyOf = (row: Row) => tables.families.find(f => f.id === row.family_id);
  const matches = (row: Row, key: string, expression: string) => {
    const value = key === 'family.closed_at' ? familyOf(row)?.closed_at : row[key];
    if (key === 'family.closed_at' && !familyOf(row)) return false;
    if (expression === 'is.null') return value === null;
    if (expression.startsWith('eq.')) return String(value) === expression.slice(3);
    if (expression.startsWith('lte.')) return String(value) <= expression.slice(4);
    if (expression.startsWith('in.(')) return expression.slice(4, -1).split(',').map(s => s.replace(/^"|"$/g, '')).includes(String(value));
    throw new Error(`Unsupported synthetic filter ${key}:${expression}`);
  };
  const reply = (data: unknown, status = 200) => new Response(status === 204 ? null : JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  const fetch: typeof globalThis.fetch = async (input, init) => {
    try {
      const request = new Request(input, init), url = new URL(request.url), table = url.pathname.slice('/rest/v1/'.length);
      if (url.origin !== 'https://push-closure-fixture.invalid' || !url.pathname.startsWith('/rest/v1/') || !(table in tables)) throw new Error('Unexpected synthetic SDK destination');
      const query = Object.fromEntries(url.searchParams); calls.push({ table, method: request.method, query }); events.push(`sdk:${table}:${request.method}`);
      const final = table === 'family_members' && request.method === 'GET' && query.user_id?.startsWith('eq.');
      if (final && query.select?.includes('family:families!inner') && Object.prototype.hasOwnProperty.call(options, 'finalReply')) return reply(options.finalReply, options.finalStatus ?? 200);
      if (request.method === 'POST') {
        const patch = await request.json() as Row;
        if (table === 'app_settings') { tables[table] = [{ ...patch }]; return reply([{ key: patch.key }], 201); }
        if (table === 'push_deliveries') { tables[table].push(patch); return reply(null, 204); }
        throw new Error('Unexpected synthetic POST');
      }
      const select = query.select ?? '*';
      if (query['family.closed_at'] && !select.includes('family:families!inner(')) throw new Error('Embedded filter without joined relationship');
      let rows = tables[table].filter(row => [...url.searchParams].every(([key, expression]) => ['select', 'order', 'offset', 'limit', 'or', 'on_conflict'].includes(key) || matches(row, key, expression)));
      if (table === 'notifications' && query.or) rows = rows.filter(row => row.related_type !== 'family_message');
      if (request.method === 'PATCH' && table === 'notifications') { const patch = await request.json() as Row; rows.forEach(row => Object.assign(row, patch)); return reply(null, 204); }
      if (request.method !== 'GET') throw new Error('Unexpected synthetic method');
      rows = rows.slice(Number(query.offset ?? 0), Number(query.offset ?? 0) + Number(query.limit ?? 1000));
      if (select !== '*') rows = rows.map(row => Object.fromEntries(split(select).map(column => {
        const embedded = /^family:families!inner\(([^)]+)\)$/.exec(column);
        if (embedded) { const family = familyOf(row); if (!family) throw new Error('Missing joined family'); return ['family', Object.fromEntries(split(embedded[1]).map(key => [key, family[key]]))]; }
        if (column.includes(':') || column.includes('(')) throw new Error('Unsupported synthetic projection');
        return [column, row[column]];
      })));
      return reply(rows);
    } catch (error) { errors.push(String(error)); throw error; }
  };
  const db = createClient<Database>('https://push-closure-fixture.invalid', 'synthetic-public-key', { accessToken: async () => null, global: { fetch }, auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  return { db, tables, calls, events, errors, close: () => { tables.families[0].closed_at = NOW.toISOString(); events.push('family:closed'); }, finalReads: () => calls.filter(c => c.table === 'family_members' && c.query.user_id?.startsWith('eq.')) };
}
beforeEach(() => { transport.endpoint.mockReset().mockResolvedValue(true); transport.web.mockReset().mockResolvedValue(undefined); transport.native.mockReset().mockResolvedValue('sent'); vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', 'synthetic-public'); vi.stubEnv('VAPID_PRIVATE_KEY', 'synthetic-private'); vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const counts = (overrides: Partial<Record<'sent' | 'skipped' | 'failed' | 'pruned' | 'withheld', number>> = {}) => ({ sent: 0, skipped: 0, failed: 0, pruned: 0, withheld: 0, ...overrides });
function noLeak(f: ReturnType<typeof fixture>) { expect(f.errors).toEqual([]); expect(transport.web).not.toHaveBeenCalled(); expect(transport.native).not.toHaveBeenCalled(); expect(f.tables.push_deliveries).toEqual([]); }

describe('queued family push observes closure after endpoint work', () => {
  for (const broadcast of [false, true]) it(`withholds ${broadcast ? 'broadcast' : 'direct'} queued payload when family closes during endpoint await`, async () => {
    const f = fixture({ broadcast });
    transport.endpoint.mockImplementationOnce(async () => { f.events.push('endpoint:begin'); await Promise.resolve(); f.close(); f.events.push('endpoint:finish'); return true; });
    const result = await dispatchPendingPushes(f.db, { now: NOW });
    expect(result.result).toEqual(counts({ withheld: 1 })); noLeak(f); expect(f.tables.notifications[0].pushed_at).not.toBeNull();
    expect(f.finalReads()).toHaveLength(1); const memberRead=f.events.lastIndexOf('sdk:family_members:GET');
    expect(memberRead).toBeGreaterThanOrEqual(0); expect(at(f.events, 'family:closed')).toBeLessThan(memberRead);
  });
  it('retains the first accepted-device receipt and withholds a later device after family closure', async () => {
    const f = fixture({ devices: 2 });
    transport.web.mockImplementationOnce(async () => { f.close(); });
    expect((await dispatchPendingPushes(f.db, { now: NOW })).result).toEqual(counts({ sent: 1, withheld: 1 }));
    expect(transport.web).toHaveBeenCalledTimes(1); expect(f.tables.push_deliveries).toHaveLength(1); expect(f.tables.push_deliveries[0].device_id).toBe(uuid(100)); expect(f.finalReads()).toHaveLength(2); expect(f.errors).toEqual([]);
  });
  for (const old of [false, true]) it(`a refused final family relation read stays pending (${old ? 'expired age' : 'new'})`, async () => {
    const f = fixture({ old, finalReply: { code: 'PGRST200', message: 'Synthetic relation unavailable' }, finalStatus: 400 });
    expect((await dispatchPendingPushes(f.db, { now: NOW })).result).toEqual(counts({ failed: 1 })); noLeak(f); expect(f.tables.notifications[0].pushed_at).toBeNull();
  });
  for (const family of [null, [], {}, { id: FOREIGN, closed_at: null }, { id: FAMILY }, { id: FAMILY, closed_at: NOW.toISOString() }]) it(`malformed final family reply refuses rather than inventing open state: ${JSON.stringify(family)}`, async () => {
    const f = fixture({ finalReply: [{ user_id: USER, family_id: FAMILY, is_active: true, family }] });
    expect((await dispatchPendingPushes(f.db, { now: NOW })).result).toEqual(counts({ failed: 1 })); noLeak(f); expect(f.tables.notifications[0].pushed_at).toBeNull();
  });
  it('refuses a malformed multi-row reply even though the final lookup is capped at one', async () => {
    const row = { user_id: USER, family_id: FAMILY, is_active: true, family: { id: FAMILY, closed_at: null } };
    const f = fixture({ finalReply: [row, row] }); expect((await dispatchPendingPushes(f.db, { now: NOW })).result).toEqual(counts({ failed: 1 })); noLeak(f); expect(f.tables.notifications[0].pushed_at).toBeNull();
  });
  it('qualifies current family and active recipient together with exact family/user filters and one-row cap', async () => {
    const f = fixture(); expect((await dispatchPendingPushes(f.db, { now: NOW })).result).toEqual(counts({ sent: 1 }));
    expect(f.finalReads()).toHaveLength(1); expect(f.finalReads()[0].query).toEqual({ select: 'user_id,family_id,is_active,family:families!inner(id,closed_at)', family_id: 'eq.' + FAMILY, user_id: 'eq.' + USER, is_active: 'eq.true', 'family.closed_at': 'is.null', limit: '1' }); expect(f.errors).toEqual([]);
  });
  it('an unchanged open family delivers and records the exact device once', async () => {
    const f = fixture(); expect((await dispatchPendingPushes(f.db, { now: NOW })).result).toEqual(counts({ sent: 1 })); expect(transport.web).toHaveBeenCalledTimes(1); expect(f.tables.push_deliveries).toEqual([{ notification_id: uuid(1), device_id: uuid(100) }]); expect(f.errors).toEqual([]);
  });
  it('an already closed family remains filtered before queue limits', async () => {
    const f = fixture({ closed: true }); expect(await dispatchPendingPushes(f.db, { now: NOW })).toEqual({ notifications: 0, result: counts() }); noLeak(f); expect(f.finalReads()).toEqual([]);
  });
  it('a generic own-user push retains its independent consent behavior', async () => {
    const f = fixture(); transport.endpoint.mockImplementationOnce(async () => { f.close(); return true; }); expect(await sendPushToUser(f.db, USER, { title: 'Synthetic own-device test' })).toEqual(counts({ sent: 1 })); expect(transport.web).toHaveBeenCalledTimes(1); expect(f.finalReads()).toEqual([]); expect(f.errors).toEqual([]);
  });
  it('membership revocation during endpoint await remains withheld', async () => {
    const f = fixture(); transport.endpoint.mockImplementationOnce(async () => { f.tables.family_members[0].is_active = false; return true; }); expect((await dispatchPendingPushes(f.db, { now: NOW })).result).toEqual(counts({ withheld: 1 })); noLeak(f);
  });
});
