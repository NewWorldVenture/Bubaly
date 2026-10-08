import { describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { deleteEvent, deleteEvents, updateEvent } from '@/lib/services/calendar';

vi.mock('@/lib/services/activity', () => ({ recordActivitySafely: vi.fn() }));
const family = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
const otherFamily = 'bbbbbbbb-bbbb-4bbb-8bbb-000000000001';
const id = 'cccccccc-cccc-4ccc-8ccc-000000000001';
type Row = { id: string; family_id: string; title: string; feed_id: string | null; external_uid: string | null };
type Operation = 'update' | 'delete' | 'batch';
const native = (extra: Partial<Row> = {}): Row => ({ id, family_id: family, title: 'Synthetic original', feed_id: null, external_uid: null, ...extra });

function fixture(initial: Row[], takeover?: (rows: Row[]) => void) {
  const rows = initial.map(row => ({ ...row }));
  const calls: { method: string; query: Record<string, string>; payload: unknown }[] = [];
  const db = createClient<Database>('https://synthetic.invalid', 'synthetic-key', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://synthetic.invalid');
      expect(url.pathname).toBe('/rest/v1/calendar_events');
      const method = init?.method ?? 'GET';
      expect(['PATCH', 'DELETE']).toContain(method);
      const query = Object.fromEntries(url.searchParams);
      const payload = init?.body ? JSON.parse(String(init.body)) : null;
      calls.push({ method, query, payload });
      // Ownership can change immediately before the actual database mutation;
      // admission must be a predicate on that mutation, not an earlier read.
      takeover?.(rows);
      const matches = rows.filter(row => [...url.searchParams].every(([column, value]) => {
        if (column === 'select') return true;
        const field = row[column as keyof Row];
        if (value.startsWith('eq.')) return field === value.slice(3);
        if (value === 'is.null') return field === null;
        if (value.startsWith('in.(')) return value.slice(4, -1).split(',').includes(String(field));
        throw new Error(`Unsupported synthetic filter ${column}=${value}`);
      }));
      const saved = matches.map(row => ({ ...row, ...(method === 'PATCH' ? payload : {}) }));
      if (method === 'PATCH') matches.forEach(row => Object.assign(row, payload));
      else matches.forEach(row => rows.splice(rows.indexOf(row), 1));
      return new Response(JSON.stringify(saved), { headers: { 'Content-Type': 'application/json' } });
    } },
  });
  const scope: ServiceScope = { db, familyId: family, memberId: 'synthetic-member', userId: 'synthetic-user', role: 'parent', actorKind: 'member', tz: 'UTC' };
  return { rows, calls, run: (operation: Operation, ids = [id]) => operation === 'update'
    ? updateEvent(scope, ids[0], { title: 'Synthetic changed' })
    : operation === 'delete' ? deleteEvent(scope, ids[0]) : deleteEvents(scope, ids) };
}

describe('native calendar writes use atomic source ownership predicates', () => {
  it.each<Operation>(['update', 'delete', 'batch'])('preserves a normal native %s', async operation => {
    const f = fixture([native()]);
    expect(await f.run(operation)).toMatchObject({ ok: true });
    expect(f.calls).toHaveLength(1);
    expect(operation === 'update' ? f.rows[0].title : f.rows.length).toBe(operation === 'update' ? 'Synthetic changed' : 0);
  });

  for (const source of [
    { feed_id: 'synthetic-feed', external_uid: 'synthetic-uid' },
    { feed_id: 'synthetic-feed', external_uid: null },
    { feed_id: null, external_uid: 'synthetic-uid' },
  ]) {
    it.each<Operation>(['update', 'delete', 'batch'])(`refuses source row ${JSON.stringify(source)} through %s`, async operation => {
      const original = native(source), f = fixture([original]);
      const result = await f.run(operation);
      expect(result).toMatchObject(operation === 'batch' ? { ok: true, data: { removed: 0 } } : { ok: false, code: 'not_found' });
      expect(f.rows).toEqual([original]);
    });
  }

  it.each<Operation>(['update', 'delete', 'batch'])('retains the foreign-family boundary during %s', async operation => {
    const original = native({ family_id: otherFamily }), f = fixture([original]);
    expect(await f.run(operation)).toMatchObject(operation === 'batch' ? { ok: true, data: { removed: 0 } } : { ok: false, code: 'not_found' });
    expect(f.rows).toEqual([original]);
    expect(f.calls[0].query.family_id).toBe(`eq.${family}`);
  });

  it.each<Operation>(['update', 'delete', 'batch'])('refuses concurrent feed takeover at the actual %s', async operation => {
    const f = fixture([native()], rows => { rows[0].feed_id = 'new-source-owner'; });
    expect(await f.run(operation)).toMatchObject(operation === 'batch' ? { ok: true, data: { removed: 0 } } : { ok: false, code: 'not_found' });
    expect(f.rows).toEqual([native({ feed_id: 'new-source-owner' })]);
    expect(f.calls).toHaveLength(1); // No preflight ownership read.
    expect(f.calls[0].query).toMatchObject({ feed_id: 'is.null', external_uid: 'is.null', family_id: `eq.${family}` });
  });

  it('bulk deletion removes only the native subset from mixed family/source rows', async () => {
    const imported = native({ id: 'cccccccc-cccc-4ccc-8ccc-000000000002', feed_id: 'synthetic-feed', external_uid: 'uid' });
    const foreign = native({ id: 'cccccccc-cccc-4ccc-8ccc-000000000003', family_id: otherFamily });
    const f = fixture([native(), imported, foreign]);
    expect(await f.run('batch', [id, imported.id, foreign.id])).toMatchObject({ ok: true, data: { removed: 1 } });
    expect(f.rows).toEqual([imported, foreign]);
  });

  it('an empty batch performs no database request', async () => {
    const f = fixture([native()]);
    expect(await f.run('batch', [])).toMatchObject({ ok: true, data: { removed: 0 } });
    expect(f.calls).toEqual([]);
  });
});
