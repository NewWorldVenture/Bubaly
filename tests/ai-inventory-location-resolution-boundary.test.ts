// A name must identify a destination from the complete matching set before
// the registered inventory tool changes an item or logs a move. Real registry,
// trust, ledger and service code; only database transport is modeled, not RLS.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

type DB = SupabaseClient<Database>;
type Builder = ReturnType<InMemorySupabase['from']>;
type Reply = Awaited<ReturnType<Builder['maybeSingle']>>;
const server = vi.hoisted(() => ({ client: null as DB | null }));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => {
    if (!server.client) throw new Error('No test ledger client');
    return server.client;
  },
}));
const { toToolSpecs } = await import('@/lib/ai/tools/legacy-adapter');
const { resolveLocationByName } = await import('@/lib/services/inventory');

const FAMILY = 'family-inventory-owner';
const TOOL = 'inventory.recordMove';
const NOW = new Date('2026-10-16T12:00:00Z');
const ITEM = { id: 'item-passports', family_id: FAMILY, name: 'Passports', location_id: 'original', status: 'in_place' };
const location = (id: string, name: string, extra: Row = {}): Row => ({ id, family_id: FAMILY, name, ...extra });
const partials = (count: number) => Array.from({ length: count }, (_, i) =>
  location(`loc-${String(i + 1).padStart(3, '0')}`, `Garage shelf ${i + 1}`));
type Fault = 'returned' | 'thrown' | 'null-data' | 'object-data' | 'missing-id' | 'data-with-error' | 'repeated-page';
type Call = { method: string; args: unknown[] };

function household(rows: Row[], options: {
  maxRows?: number; fault?: Fault; faultAt?: number; enabled?: boolean; role?: ServiceScope['role'];
} = {}) {
  const db = createInMemorySupabase({
    maxRows: options.maxRows, likeSyntax: 'postgrest',
    uniques: { ai_tool_calls: [['family_id', 'idempotency_key']] },
    defaults: {
      inventory_items: { category: 'documents', quantity: 1, value_cents: null, brand: null, model: null,
        serial_number: null, tags: [], lent_to: null, lent_on: null, warranty_until: null, owner_member_id: null, notes: null },
      home_locations: { kind: 'room', parent_id: null, notes: null },
      inventory_moves: { from_location_id: null, to_location_id: null, moved_by: null, reason: null },
    },
  });
  db.seed('home_locations', [...rows, location('original', 'Office')]);
  db.seed('inventory_items', [ITEM]);
  db.seed('family_ai_settings', [{ family_id: FAMILY, enabled: options.enabled ?? true, behavior: 'execute' }]);
  const queries: Call[][] = [];
  const writes: { table: string; method: string; args: unknown[] }[] = [];
  let firstPage: Reply | undefined;
  const from = db.from.bind(db);
  vi.spyOn(db, 'from').mockImplementation((table) => {
    const builder = from(table);
    const calls: Call[] = [];
    const proxy = new Proxy(builder, {
      get(target, key) {
        if (key === 'then') {
          return (resolve: (value: Reply) => unknown, reject: (cause: unknown) => unknown) => {
            const read = async (): Promise<Reply> => {
              const lookup = table === 'home_locations' && calls.some((c) => c.method === 'ilike');
              if (!lookup) return await target;
              queries.push(structuredClone(calls));
              if (queries.length > 30) throw new Error('Fixture lookup request ceiling exceeded');
              const reply = await target;
              if (queries.length === 1) firstPage = structuredClone(reply);
              if (options.fault && queries.length === (options.faultAt ?? 1)) {
                const error = { code: '42501', message: 'Synthetic location lookup refusal', details: null, hint: null };
                switch (options.fault) {
                  case 'returned': return { ...reply, data: null, error };
                  case 'thrown': throw new Error('Synthetic location lookup transport failure');
                  case 'null-data': return { ...reply, data: null };
                  case 'object-data': return { ...reply, data: { id: 'loc-000', name: 'Garage' } };
                  case 'missing-id': return { ...reply, data: [{ name: 'Garage', family_id: FAMILY }] };
                  case 'data-with-error': return { ...reply, error };
                  case 'repeated-page': return structuredClone(firstPage!);
                }
              }
              return reply;
            };
            return read().then(resolve, reject);
          };
        }
        const value = Reflect.get(target, key);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          calls.push({ method: String(key), args });
          if (['insert', 'update', 'upsert', 'delete'].includes(String(key))) {
            writes.push({ table, method: String(key), args: structuredClone(args) });
          }
          const result = Reflect.apply(value, target, args);
          return result === target ? proxy : result;
        };
      },
    });
    return proxy;
  });
  const client = db as unknown as DB;
  server.client = client;
  const scope: ServiceScope = {
    db: client, familyId: FAMILY, userId: 'auth-parent', memberId: 'member-parent',
    role: options.role ?? 'parent', actorKind: 'ai', tz: 'UTC', now: NOW,
  };
  const spec = toToolSpecs(scope, { names: [TOOL] })[0];
  const before = structuredClone(db.table('inventory_items'));
  return { db, scope, queries, writes, before,
    call: (args: Record<string, unknown> = {}) => spec.execute({ item_id: ITEM.id, to_location: 'Garage', ...args }),
  };
}
type Household = ReturnType<typeof household>;

function expectNoMove(h: Household) {
  expect(h.db.table('inventory_items')).toEqual(h.before);
  expect(h.db.table('inventory_moves')).toEqual([]);
  expect(h.db.table('agent_activity')).toEqual([]);
  expect(h.writes.filter((w) => w.table === 'inventory_items' || w.table === 'inventory_moves')).toEqual([]);
}

function expectRefusedMove(h: Household, result: unknown, ambiguity = false) {
  // Capture the actual committed effects alongside the returned result on RED,
  // rather than stopping at ok:true before showing the erroneous move.
  expect({ result, items: h.db.table('inventory_items'), moves: h.db.table('inventory_moves'),
    activity: h.db.table('agent_activity') }).toMatchObject({
    result: { ok: false, ...(ambiguity ? { error: expect.stringContaining('say which one') } : {}) },
    items: h.before, moves: [], activity: [],
  });
  expectNoMove(h);
}

function expectMoved(h: Household, id: string) {
  expect(h.db.table('inventory_items')).toEqual([{ ...h.before[0], location_id: id }]);
  expect(h.db.table('inventory_moves')).toEqual([expect.objectContaining({
    item_id: ITEM.id, family_id: FAMILY, from_location_id: 'original', to_location_id: id,
    moved_by: 'member-parent', created_by: 'auth-parent', moved_at: NOW.toISOString(),
  })]);
  expect(h.writes.filter((w) => w.table === 'inventory_items').map((w) => w.method)).toEqual(['update']);
  expect(h.writes.filter((w) => w.table === 'inventory_moves').map((w) => w.method)).toEqual(['insert']);
  expect(h.db.table('ai_tool_calls')).toEqual([expect.objectContaining({
    family_id: FAMILY, tool_name: TOOL, state: 'succeeded', resource_table: 'inventory_moves',
  })]);
  expect(h.db.table('agent_activity')).toHaveLength(1);
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('This fixture may not use the network'); }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  server.client = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('inventory names are resolved from complete matching candidates', () => {
  it.each(['Garage', 'gArAgE', ' Garage '])('refuses the hidden duplicate %s beyond the first ten matches before any move', async (duplicate) => {
    const h = household([location('loc-000', 'Garage'), ...partials(9), location('loc-010', duplicate)]);
    expectRefusedMove(h, await h.call(), true);
    expect(h.db.table('ai_tool_calls')).toEqual([expect.objectContaining({ state: 'failed' })]);
  });

  it('finds the sole exact destination beyond ten partial matches and persists that exact ID', async () => {
    const h = household([...partials(10), location('loc-011', 'Garage')]);
    expect(await h.call()).toMatchObject({ ok: true, verified: true,
      summary: 'Moved Passports to Garage', data: { where: 'Garage', from: 'Office', item_id: ITEM.id } });
    expectMoved(h, 'loc-011');
  });

  it('does not turn a one-row server cap into permission to choose between partial names', async () => {
    const h = household([location('loc-000', 'Garage north'), location('loc-001', 'Garage south')], { maxRows: 1 });
    expectRefusedMove(h, await h.call(), true);
    expect(h.queries).toHaveLength(3);
    for (const calls of h.queries) {
      expect(calls).toContainEqual({ method: 'eq', args: ['family_id', FAMILY] });
      expect(calls).toContainEqual({ method: 'ilike', args: ['name', '%Garage%'] });
      expect(calls).toContainEqual({ method: 'order', args: ['id', { ascending: true }] });
    }
    expect(h.queries[1]).toContainEqual({ method: 'gt', args: ['id', 'loc-000'] });
    expect(h.queries[2]).toContainEqual({ method: 'gt', args: ['id', 'loc-001'] });
  });

  it('an exact match seen before a later page error cannot authorize a move', async () => {
    const h = household([location('loc-000', 'Garage'), location('loc-001', 'Garage shelf')], {
      maxRows: 1, faultAt: 2, fault: 'returned',
    });
    expectRefusedMove(h, await h.call());
    expect(h.queries).toHaveLength(2);
  });

  it('rejects a repeated keyset page rather than accepting the first exact name', async () => {
    const h = household([location('loc-000', 'Garage'), location('loc-001', 'Garage shelf')], {
      maxRows: 1, faultAt: 2, fault: 'repeated-page',
    });
    await expect(resolveLocationByName(h.scope, 'Garage')).resolves.toMatchObject({ ok: false, code: 'db' });
    expectNoMove(h);
    expect(h.queries).toHaveLength(2);
  });

  it('refuses more than 500 matching candidates instead of trusting an exact match in the prefix', async () => {
    const h = household([location('loc-000', 'Garage'), ...partials(500)]);
    expectRefusedMove(h, await h.call());
    expect(h.queries).toHaveLength(1);
    expect(h.queries[0]).toContainEqual({ method: 'limit', args: [501] });
  });

  it('accepts exactly 500 matching candidates within a bounded query count', async () => {
    const h = household([location('loc-000', 'Garage'), ...partials(499)]);
    await expect(resolveLocationByName(h.scope, 'Garage')).resolves.toMatchObject({ ok: true, data: { id: 'loc-000' } });
    expect(h.queries.length).toBeLessThanOrEqual(2);
    expectNoMove(h);
  });

  it('applies the ceiling only to matches, not to more than 500 unrelated locations', async () => {
    const h = household([
      ...Array.from({ length: 501 }, (_, i) => location(`unrelated-${String(i).padStart(3, '0')}`, `Storage ${i}`)),
      location('matching', 'Garage'),
    ]);
    await expect(resolveLocationByName(h.scope, 'Garage')).resolves.toMatchObject({ ok: true, data: { id: 'matching' } });
    expect(h.queries.length).toBeLessThanOrEqual(2);
    expectNoMove(h);
  });
});

describe('existing name precedence and allowed commands remain intact', () => {
  it.each(['the garage', 'MY Garage', 'our GARAGE', ' Garage '])('keeps exact-first matching and prefix normalization for %s', async (name) => {
    const h = household([location('loc-000', 'Garage shelf'), location('loc-001', 'Garage')]);
    expect(await h.call({ to_location: name })).toMatchObject({ ok: true, verified: true });
    expectMoved(h, 'loc-001');
  });

  it('preserves a stored trimmed exact name over partial names', async () => {
    const h = household([location('loc-000', 'Garage shelf'), location('loc-001', ' Garage ')]);
    expect(await h.call()).toMatchObject({ ok: true, verified: true });
    expectMoved(h, 'loc-001');
  });

  it('keeps a unique partial destination and the no-match result distinct', async () => {
    const h = household([location('loc-000', 'Garage shelf')]);
    expect(await h.call()).toMatchObject({ ok: true, verified: true });
    expectMoved(h, 'loc-000');
    await expect(resolveLocationByName(h.scope, 'Attic')).resolves.toEqual({ ok: true, data: null });
  });

  it('refuses two nearby exact names without a write', async () => {
    const h = household([location('loc-000', 'Garage'), location('loc-001', 'GARAGE')]);
    expect(await h.call()).toMatchObject({ ok: false, error: expect.stringContaining('say which one') });
    expectNoMove(h);
  });

  it('excludes another family with the same exact name', async () => {
    const h = household([location('loc-000', 'Garage'), location('loc-001', 'Garage', { family_id: 'other-family' })]);
    expect(await h.call()).toMatchObject({ ok: true });
    expectMoved(h, 'loc-000');
  });

  it.each(['Box_1', '50% shelf', 'Path\\box'])('keeps literal LIKE characters in %s', async (name) => {
    const h = household([location('loc-000', name), location('loc-001', 'BoxX1'), location('loc-002', '500 shelf')]);
    expect(await h.call({ to_location: name })).toMatchObject({ ok: true });
    expectMoved(h, 'loc-000');
  });

  it('does not query for a blank location name', async () => {
    const h = household([location('loc-000', 'Garage')]);
    await expect(resolveLocationByName(h.scope, '   ')).resolves.toEqual({ ok: true, data: null });
    expect(h.queries).toEqual([]);
    expectNoMove(h);
  });

  it('an explicit location ID disambiguates two equal names without a name lookup', async () => {
    const h = household([location('loc-000', 'Garage'), location('loc-001', 'Garage')]);
    expect(await h.call({ to_location_id: 'loc-001' })).toMatchObject({ ok: true, verified: true });
    expectMoved(h, 'loc-001');
    expect(h.queries).toEqual([]);
  });

  it('confirmation uses the saved location and performs no destination lookup or item update', async () => {
    const h = household([location('loc-000', 'Garage'), location('loc-001', 'Garage')]);
    expect(await h.call({ confirm: true })).toMatchObject({ ok: true, verified: true,
      summary: 'Confirmed Passports is still in Office', data: { confirmed: true, where: 'Office' } });
    expect(h.db.table('inventory_items')).toEqual(h.before);
    expect(h.db.table('inventory_moves')).toEqual([expect.objectContaining({
      from_location_id: 'original', to_location_id: 'original', reason: 'confirmed',
    })]);
    expect(h.writes.filter((w) => w.table === 'inventory_items')).toEqual([]);
    expect(h.queries).toEqual([]);
  });
});

describe('lookup failures and actual trust denials cannot become moves', () => {
  it.each(['returned', 'thrown', 'null-data', 'object-data', 'missing-id', 'data-with-error'] as const)(
    'returns a direct service failure for %s before any domain write', async (fault) => {
      const h = household([location('loc-000', 'Garage')], { fault });
      await expect(resolveLocationByName(h.scope, 'Garage')).resolves.toMatchObject({ ok: false, code: 'db' });
      expectNoMove(h);
      expect(h.queries).toHaveLength(1);
    },
  );

  it.each([{ enabled: false }, { role: 'guest' as const }])('preserves the real trust refusal for %j', async (options) => {
    const h = household([location('loc-000', 'Garage')], options);
    expect(await h.call()).toMatchObject({ ok: false });
    expectNoMove(h);
    expect(h.queries).toEqual([]);
    expect(h.db.table('ai_tool_calls')).toEqual([]);
  });
});
