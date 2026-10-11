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
function fixture(options: { broadcast?: boolean; devices?: number; old?: boolean; closed?: boolean; finalReply?: unknown; finalStatus?: number; preferenceReply?: unknown; preferenceStatus?: number; preferenceThrow?: boolean; onDevices?: () => void; child?: boolean } = {}) {
  const tables: Record<string, Row[]> = {
    families: [{ id: FAMILY, closed_at: options.closed ? NOW.toISOString() : null }],
    family_members: [{ id: uuid(10), family_id: FAMILY, user_id: USER, is_active: true, role: options.child ? 'child' : 'parent' }],
    notifications: [{ id: uuid(1), family_id: FAMILY, user_id: options.broadcast ? null : USER, title: 'Synthetic private family reminder', body: 'Synthetic only', related_type: null, related_id: null, send_at: NOW.toISOString(), created_at: options.old ? '2026-10-01T15:00:00Z' : NOW.toISOString(), pushed_at: null }],
    push_devices: Array.from({ length: options.devices ?? 1 }, (_, i) => ({ id: uuid(100 + i), user_id: USER, provider: 'webpush', platform: 'web', enabled: true, endpoint: `https://push-device.example.test/${i}`, p256dh: 'synthetic-public', auth: 'synthetic-auth' })),
    family_ai_settings: options.child ? [{ family_id: FAMILY, child_channels: { push: true } }] : [], user_preferences: [{ user_id: USER, push_enabled: true }], push_deliveries: [], app_settings: [],
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
      if (url.origin !== 'https://push-consent-race-fixture.invalid' || !url.pathname.startsWith('/rest/v1/') || !(table in tables)) throw new Error('Unexpected synthetic SDK destination');
      const query = Object.fromEntries(url.searchParams); calls.push({ table, method: request.method, query }); events.push(`sdk:${table}:${request.method}`);
      if (table === 'push_devices' && request.method === 'GET') options.onDevices?.();
      if (table === 'user_preferences' && request.method === 'GET' && query.user_id?.startsWith('eq.')) {
        if (options.preferenceThrow) throw new Error('Synthetic final preference transport failure');
        if (Object.prototype.hasOwnProperty.call(options, 'preferenceReply')) return reply(options.preferenceReply, options.preferenceStatus ?? 200);
      }
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
  const db = createClient<Database>('https://push-consent-race-fixture.invalid', 'synthetic-public-key', { accessToken: async () => null, global: { fetch }, auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
  return { db, tables, calls, events, errors, close: () => { tables.families[0].closed_at = NOW.toISOString(); events.push('family:closed'); }, finalReads: () => calls.filter(c => c.table === 'family_members' && c.query.user_id?.startsWith('eq.')) };
}
beforeEach(() => { transport.endpoint.mockReset().mockResolvedValue(true); transport.web.mockReset().mockResolvedValue(undefined); transport.native.mockReset().mockResolvedValue('sent'); vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', 'synthetic-public'); vi.stubEnv('VAPID_PRIVATE_KEY', 'synthetic-private'); vi.spyOn(console, 'error').mockImplementation(() => {}); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const counts = (overrides: Partial<Record<'sent' | 'skipped' | 'failed' | 'pruned' | 'withheld', number>> = {}) => ({ sent: 0, skipped: 0, failed: 0, pruned: 0, withheld: 0, ...overrides });
function noLeak(f: ReturnType<typeof fixture>) { expect(transport.web).not.toHaveBeenCalled(); expect(transport.native).not.toHaveBeenCalled(); expect(f.tables.push_deliveries).toEqual([]); }


describe('queued family push observes current user preference after endpoint work', () => {
  for (const broadcast of [false, true]) it(`withholds ${broadcast ? 'broadcast' : 'direct'} payload after opt-out during endpoint await`, async () => {
    const f = fixture({ broadcast });
    transport.endpoint.mockImplementationOnce(async () => { f.events.push('endpoint:begin'); await Promise.resolve(); f.tables.user_preferences[0].push_enabled = false; f.events.push('preference:off'); return true; });
    expect((await dispatchPendingPushes(f.db, { now: NOW })).result).toEqual(counts({ withheld: 1 })); noLeak(f); expect(f.errors).toEqual([]); expect(f.tables.notifications[0].pushed_at).not.toBeNull();
    const preferenceRead=f.events.lastIndexOf('sdk:user_preferences:GET');
    expect(preferenceRead).toBeGreaterThanOrEqual(0);
    expect(at(f.events, 'preference:off')).toBeLessThan(preferenceRead); expect(f.finalReads()).toEqual([]);
  });
  it('withholds a native payload after opt-out during device lookup', async () => {
    let f: ReturnType<typeof fixture>; f=fixture({ onDevices: () => { f.tables.user_preferences[0].push_enabled=false; } });
    Object.assign(f.tables.push_devices[0], {provider:'fcm',platform:'android',token:'synthetic-native-token'});
    expect((await dispatchPendingPushes(f.db,{now:NOW})).result).toEqual(counts({withheld:1})); noLeak(f); expect(f.errors).toEqual([]); expect(f.tables.notifications[0].pushed_at).not.toBeNull();
  });
  it('retains the first accepted receipt and withholds the later device when the user opts out', async () => {
    const f=fixture({devices:2}); transport.web.mockImplementationOnce(async()=>{f.tables.user_preferences[0].push_enabled=false;});
    expect((await dispatchPendingPushes(f.db,{now:NOW})).result).toEqual(counts({sent:1,withheld:1})); expect(transport.web).toHaveBeenCalledTimes(1); expect(f.tables.push_deliveries).toEqual([{notification_id:uuid(1),device_id:uuid(100)}]); expect(f.errors).toEqual([]);
  });
  for(const old of [false,true]) it(`an unreadable current preference stays pending (${old?'expired':'fresh'} age)`,async()=>{
    const f=fixture({old,preferenceReply:{code:'42501',message:'Synthetic current preference unavailable'},preferenceStatus:403});
    expect((await dispatchPendingPushes(f.db,{now:NOW})).result).toEqual(counts({failed:1})); noLeak(f); expect(f.errors).toEqual([]); expect(f.tables.notifications[0].pushed_at).toBeNull();
  });
  it('a thrown current preference transport read cannot send or acknowledge',async()=>{
    const f=fixture({preferenceThrow:true}); expect((await dispatchPendingPushes(f.db,{now:NOW})).result).toEqual(counts({failed:1})); noLeak(f); expect(f.errors.length).toBeGreaterThan(0); expect(f.tables.notifications[0].pushed_at).toBeNull();
  });
  for(const preference of [null,{},'not rows',[null],[{}],[{user_id:FOREIGN,push_enabled:true}],[{user_id:USER,push_enabled:'false'}],[{user_id:USER,push_enabled:null}],[{user_id:USER}],[{user_id:USER,push_enabled:true},{user_id:USER,push_enabled:true}]]) it(`malformed final preference reply stays pending: ${JSON.stringify(preference)}`,async()=>{
    const f=fixture({preferenceReply:preference}); expect((await dispatchPendingPushes(f.db,{now:NOW})).result).toEqual(counts({failed:1})); noLeak(f); expect(f.errors).toEqual([]); expect(f.tables.notifications[0].pushed_at).toBeNull();
  });
  it('keeps the established absent-preference default without inventing an opt-out',async()=>{
    const f=fixture(); transport.endpoint.mockImplementationOnce(async()=>{f.tables.user_preferences=[];return true;});
    expect((await dispatchPendingPushes(f.db,{now:NOW})).result).toEqual(counts({sent:1})); expect(transport.web).toHaveBeenCalledTimes(1); expect(f.errors).toEqual([]);
  });
  it('current true permission retains delivery with exact user and one-row preference qualifiers',async()=>{
    const f=fixture(); expect((await dispatchPendingPushes(f.db,{now:NOW})).result).toEqual(counts({sent:1}));
    const reads=f.calls.filter(c=>c.table==='user_preferences'&&c.query.user_id?.startsWith('eq.')); expect(reads).toHaveLength(1); expect(reads[0].query).toEqual({select:'user_id,push_enabled',user_id:'eq.'+USER,limit:'1'}); const preferenceRead=f.events.lastIndexOf('sdk:user_preferences:GET'), memberRead=f.events.lastIndexOf('sdk:family_members:GET');
    expect(preferenceRead).toBeGreaterThanOrEqual(0); expect(memberRead).toBeGreaterThanOrEqual(0); expect(preferenceRead).toBeLessThan(memberRead); expect(f.errors).toEqual([]);
  });
  it('an initial opt-out still accesses no devices or final preference query',async()=>{
    const f=fixture(); f.tables.user_preferences[0].push_enabled=false; expect((await dispatchPendingPushes(f.db,{now:NOW})).result).toEqual(counts({withheld:1})); noLeak(f); expect(f.calls.some(c=>c.table==='push_devices')).toBe(false); expect(f.calls.filter(c=>c.table==='user_preferences')).toHaveLength(1); expect(f.errors).toEqual([]);
  });
  it('initial parental channel denial remains withheld without final delivery work',async()=>{
    const f=fixture({child:true}); f.tables.family_ai_settings[0].child_channels={push:false}; expect((await dispatchPendingPushes(f.db,{now:NOW})).result).toEqual(counts({withheld:1})); noLeak(f); expect(f.calls.some(c=>c.table==='push_devices')).toBe(false); expect(f.errors).toEqual([]);
  });
  it('an initially closed family remains filtered before the queue limit',async()=>{
    const f=fixture({closed:true}); expect(await dispatchPendingPushes(f.db,{now:NOW})).toEqual({notifications:0,result:counts()}); noLeak(f); expect(f.calls.filter(c=>c.table==='user_preferences')).toEqual([]); expect(f.errors).toEqual([]);
  });
  it('a healthy own-user push preserves its independent complete initial consent check',async()=>{
    const f=fixture(); expect(await sendPushToUser(f.db,USER,{title:'Synthetic own-device test'})).toEqual(counts({sent:1})); expect(transport.web).toHaveBeenCalledTimes(1); expect(f.calls.filter(c=>c.table==='user_preferences')).toHaveLength(1); expect(f.finalReads()).toEqual([]); expect(f.errors).toEqual([]);
  });
});
