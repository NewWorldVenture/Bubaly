// Installed Supabase/PostgREST client, synthetic bounded HTTP transport. No
// native snapshot, concurrent uniqueness, production or provider claims.
import { afterEach, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { findOrCreateVacation, listTrips } from '@/lib/services/trips';
import { tripTools } from '@/lib/ai/tools/trips';

type Row = Record<string, unknown>;
type Fault = 'refuse' | 'throw' | 'missing-count' | 'changed-count' | 'duplicate' | 'empty-page' | 'malformed' | 'data-error';
const FAMILY = 'trip-family';
const ORIGIN = 'https://trip-resolution.synthetic.invalid';
const violations: string[] = [];
afterEach(() => { expect(violations.splice(0)).toEqual([]); });
const trip = (i: number, extra: Row = {}): Row => ({
  id: `trip-${String(i).padStart(5, '0')}`, family_id: FAMILY, title: `Ordinary trip ${i}`,
  destination: 'Elsewhere', start_date: '2026-11-01', end_date: '2026-11-07',
  status: 'planning', kind: 'domestic', timezone: 'UTC', ...extra,
});
function fixture(seed: Row[], options: { cap?: number; fault?: Fault; faultAt?: number } = {}) {
  const rows = seed.map(r => ({ ...r }));
  const requests: URL[] = [];
  const writes: { table: string; payload: Row }[] = [];
  const scans: { offset: number; limit: number; order: string | null; counted: boolean }[] = [];
  const combinedReplies: { dataLength: number | null; count: number | null; code: string }[] = [];
  const faultAt = options.faultAt ?? 1;
  const db = createClient<Database>(ORIGIN, 'synthetic-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input, init) => {
      const url = new URL(String(input)); requests.push(url);
      const require = (ok: boolean, message: string) => {
        if (!ok) { violations.push(message); throw new Error(message); }
      };
      require(url.origin === ORIGIN, 'Unexpected network origin');
      const table = url.pathname.split('/').at(-1)!;
      const method = init?.method ?? 'GET';
      require(url.pathname === `/rest/v1/${table}` && ['vacations', 'audit_logs'].includes(table), 'Unexpected table');
      if (method === 'POST') {
        const payload = JSON.parse(String(init?.body)) as Row;
        require(payload.family_id === FAMILY, 'Write missing family');
        writes.push({ table, payload });
        if (table === 'audit_logs') return new Response(null, { status: 201 });
        const saved = { id: `created-${writes.length}`, status: 'planning', ...payload };
        rows.push(saved);
        return Response.json(saved, { status: 201 });
      }
      require(method === 'GET' && table === 'vacations', 'Unexpected operation');
      const p = url.searchParams;
      require(p.get('family_id') === `eq.${FAMILY}` && p.get('select') === '*', 'Read missing family/projection');
      require([...p.keys()].every(k => ['family_id', 'select', 'status', 'order', 'limit', 'offset', 'title', 'start_date'].includes(k)), 'Unexpected query clause');
      let eligible = rows.filter(r => r.family_id === FAMILY);
      const live = p.has('status');
      if (live) {
        require(p.get('status') === 'in.(planning,booked,active)', 'Wrong live statuses');
        eligible = eligible.filter(r => ['planning', 'booked', 'active'].includes(String(r.status)));
      }
      if (p.has('title')) {
        require(!live && p.get('title')!.startsWith('ilike.') && p.get('limit') === '1', 'Wrong fallback probe');
        const wanted = p.get('title')!.slice(6).replace(/\\(.)/g, '$1').toLowerCase();
        eligible = eligible.filter(r => String(r.title).toLowerCase() === wanted);
      }
      const start = p.get('start_date');
      if (start) eligible = eligible.filter(r => start === 'is.null' ? r.start_date == null : r.start_date === start.slice(3));
      const order = p.get('order');
      if (order) {
        require(['start_date.asc.nullslast', 'start_date.asc.nullslast,id.asc'].includes(order), 'Wrong deterministic ordering');
        eligible.sort((a, b) => {
          for (const rule of order.split(',')) {
            const key = rule.split('.')[0];
            if (a[key] == null && b[key] == null) continue;
            if (a[key] == null) return 1;
            if (b[key] == null) return -1;
            const cmp = String(a[key]).localeCompare(String(b[key]));
            if (cmp) return cmp;
          }
          return 0;
        });
      }
      const offset = Number(p.get('offset') ?? 0), limit = Number(p.get('limit') ?? 1000);
      require(Number.isInteger(offset) && offset >= 0 && offset <= 2000 && Number.isInteger(limit) && limit > 0 && limit <= 1000, 'Unbounded page');
      const counted = new Headers(init?.headers).get('prefer')?.includes('count=exact') ?? false;
      if (live) scans.push({ offset, limit, order, counted });
      require(scans.length <= 40, 'Unbounded/repeated scan');
      const fault = live && (offset > 0 ? 2 : 1) >= faultAt ? options.fault : undefined;
      if (fault === 'refuse') return Response.json({ code: '42501', message: 'Synthetic candidate read refused' }, { status: 403 });
      if (fault === 'throw') throw new TypeError('Synthetic candidate transport failure');
      const from = fault === 'duplicate' ? 0 : offset;
      let page = eligible.slice(from, from + Math.min(limit, options.cap ?? 1000));
      if (fault === 'empty-page') page = [];
      const total = eligible.length + (fault === 'changed-count' ? 1 : 0);
      return Response.json(fault === 'malformed' ? { invalid: true } : page, {
        headers: counted && fault !== 'missing-count' ? { 'Content-Range': `${offset}-${Math.max(offset, offset + page.length - 1)}/${total}` } : {},
      });
    } },
  });
  // A data+error shape is not an HTTP response. This one explicitly declared
  // adapter fault supplements the SDK cases without pretending it is native.
  const scopedDb = options.fault === 'data-error' ? new Proxy(db, { get(target, key) {
    if (key !== 'from') return Reflect.get(target, key, target);
    return (table: 'vacations') => {
      const query = target.from(table).select('*', { count: 'exact' });
      const wrapped: typeof query = new Proxy(query, { get(builder, method) {
        if (method === 'select') return () => wrapped;
        if (method === 'then') return (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve(builder).then(value => {
          const error = { code: '42501', message: 'Synthetic data plus error' };
          combinedReplies.push({ dataLength: Array.isArray(value.data) ? value.data.length : null, count: value.count, code: error.code });
          return resolve({ ...value, error });
        }, reject);
        const value: unknown = Reflect.get(builder, method, builder);
        return typeof value === 'function' ? (...args: unknown[]) => {
          const result: unknown = Reflect.apply(value, builder, args); return result === builder ? wrapped : result;
        } : value;
      } });
      return wrapped;
    };
  } }) : db;
  const scope: ServiceScope = { db: scopedDb, familyId: FAMILY, userId: 'user', memberId: 'member', role: 'parent', actorKind: 'member', tz: 'UTC', idempotencyKey: 'trip-operation' };
  return { rows, requests, writes, scans, scope, combinedReplies };
}

describe('trip resolution reads the complete bounded candidate set', () => {
  it('reuses a destination match beyond the old fifty-row prefix through the real registered tool', async () => {
    const f = fixture([...Array.from({ length: 50 }, (_, i) => trip(i)), trip(50, { title: 'Anniversary', destination: 'Paris' })]);
    const result = await tripTools.find(t => t.name === 'trips.findOrCreateVacation')!.execute(f.scope, { destination: 'Paris' });
    expect(result).toMatchObject({ ok: true, data: { id: 'trip-00050', created: false } });
    expect(f.writes).toEqual([]); expect(f.rows).toHaveLength(51);
  });
  it('follows actual returned page lengths despite a lower server cap, retaining deterministic ties', async () => {
    const seed = [...Array.from({ length: 20 }, (_, i) => trip(i)), trip(20, { title: 'My PARIS anniversary', start_date: null })].reverse();
    const f = fixture(seed, { cap: 3 });
    expect(await findOrCreateVacation(f.scope, { title: 'paris' })).toMatchObject({ ok: true, data: { created: false, vacation: { id: 'trip-00020' } } });
    expect(f.scans.map(s => s.offset)).toEqual([0, 3, 6, 9, 12, 15, 18]);
    expect(f.scans.every(s => s.counted && s.order === 'start_date.asc.nullslast,id.asc')).toBe(true);
    expect(f.writes).toEqual([]);
  });
  it('chooses earliest matching dates then stable id, including equal-date candidates', async () => {
    const f = fixture([trip(9, { destination: 'Paris' }), trip(3, { destination: 'Paris' }), trip(1, { destination: 'Paris', start_date: '2026-12-01' })], { cap: 1 });
    expect(await findOrCreateVacation(f.scope, { destination: 'Paris' })).toMatchObject({ ok: true, data: { vacation: { id: 'trip-00003' }, created: false } });
    expect(f.writes).toEqual([]);
  });
  it.each(['refuse', 'throw', 'missing-count', 'changed-count', 'duplicate', 'empty-page', 'malformed'] as const)('later %s cannot become absence and a new trip', async fault => {
    const f = fixture(Array.from({ length: 4 }, (_, i) => trip(i)), { cap: 2, fault, faultAt: 2 });
    const result = await findOrCreateVacation(f.scope, { destination: 'Paris' });
    expect(result).toMatchObject({ ok: false, code: 'db' });
    expect(f.writes).toEqual([]); expect(f.rows).toHaveLength(4);
    expect(f.scans.some(s => s.offset === 2)).toBe(true);
  });
  it.each(['refuse', 'throw', 'missing-count', 'malformed', 'data-error'] as const)('first-page %s refuses before any writes', async fault => {
    const f = fixture([trip(0)], { fault });
    expect(await findOrCreateVacation(f.scope, { destination: 'Paris' })).toMatchObject({ ok: false, code: 'db' });
    expect(f.writes).toEqual([]);
    if (fault === 'data-error') expect(f.combinedReplies).toEqual([{ dataLength: 1, count: 1, code: '42501' }]);
  });
  it('refuses over 2000 live candidates rather than raising the display cap and guessing absence', async () => {
    const f = fixture(Array.from({ length: 2001 }, (_, i) => trip(i)));
    expect(await findOrCreateVacation(f.scope, { destination: 'Paris' })).toMatchObject({ ok: false, code: 'db' });
    expect(f.writes).toEqual([]); expect(f.scans).toHaveLength(1);
  });
  it('accepts exactly 2000 complete candidates, including the final matching row', async () => {
    const f = fixture(Array.from({ length: 2000 }, (_, i) => trip(i, i === 1999 ? { destination: 'Paris' } : {})));
    expect(await findOrCreateVacation(f.scope, { destination: 'Paris' })).toMatchObject({ ok: true, data: { created: false, vacation: { id: 'trip-01999' } } });
    expect(f.scans.map(s => s.offset)).toEqual([0, 1000]); expect(f.writes).toEqual([]);
  });
});

describe('trip resolution compatibility', () => {
  it('creates once only after complete absence and reuses the same operation result', async () => {
    const f = fixture([trip(1)], { cap: 1 });
    const input = { destination: 'Paris', timezone: 'europe/paris' };
    const first = await findOrCreateVacation(f.scope, input);
    expect(first).toMatchObject({ ok: true, data: { created: true, vacation: { title: 'Trip to Paris', timezone: 'Europe/Paris' } } });
    expect(await findOrCreateVacation(f.scope, input)).toMatchObject({ ok: true, data: { created: false, vacation: { id: first.ok && first.data.vacation.id } } });
    expect(f.writes.filter(w => w.table === 'vacations')).toHaveLength(1);
    expect(f.writes.filter(w => w.table === 'audit_logs')).toHaveLength(1);
  });
  it('excludes foreign and completed/cancelled matches and rejects conflicting dates', async () => {
    const f = fixture([trip(0, { destination: 'Paris', family_id: 'other' }), trip(1, { destination: 'Paris', status: 'completed' }), trip(2, { destination: 'Paris', status: 'cancelled' }), trip(3, { destination: 'Paris' })]);
    expect(await findOrCreateVacation(f.scope, { destination: 'Paris', startDate: '2026-12-20' })).toMatchObject({ ok: true, data: { created: true } });
    expect(f.scans).toHaveLength(1); expect(f.writes.filter(w => w.table === 'vacations')).toHaveLength(1);
  });
  it('retains the exact-title idempotency fallback for a non-live undated trip', async () => {
    const f = fixture([trip(1, { title: 'Trip to Paris', destination: 'Paris', start_date: null, status: 'completed' })]);
    expect(await findOrCreateVacation(f.scope, { destination: 'Paris' })).toMatchObject({ ok: true, data: { created: false, vacation: { id: 'trip-00001' } } });
    expect(f.writes).toEqual([]);
  });
  it.each([{ destination: 'Paris', timezone: '+09:00' }, { destination: 'Paris', startDate: 'bad' }, { title: '' }])('invalid input %j does not query or write', async input => {
    const f = fixture([]);
    expect(await findOrCreateVacation(f.scope, input)).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(f.requests).toEqual([]); expect(f.writes).toEqual([]);
  });
  it('keeps the public listTrips default and explicit display limits unchanged', async () => {
    const f = fixture(Array.from({ length: 250 }, (_, i) => trip(i)));
    const ordinary = await listTrips(f.scope), larger = await listTrips(f.scope, { limit: 999 });
    expect(ordinary.ok && ordinary.data).toHaveLength(50); expect(larger.ok && larger.data).toHaveLength(200);
    expect(f.scans.map(s => s.limit)).toEqual([50, 200]); expect(f.writes).toEqual([]);
  });
});
