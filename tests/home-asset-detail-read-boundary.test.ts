import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { loadAssetDetail } from '@/lib/home/asset-detail';

// The asset detail view has five panels that all have a plausible-looking empty
// state — "no warranty", "no manual", "no service", "no open maintenance", "no
// projects". Each of those sentences is a claim about a family's house, and a
// failed read must never be allowed to make it. These tests pin the fail-closed
// contract table by table, plus the log line that makes the failure diagnosable.

type Reply = { data: unknown; error: unknown; count?: number | null };

const ASSET_ROW = {
  id: 'asset-1',
  family_id: 'fam-1',
  name: 'Water heater',
  category: 'water_heater',
  location: 'Basement',
  brand: null,
  model: null,
  purchased_on: null,
  warranty_until: '2030-01-01',
  notes: null,
  home_id: null,
  serial_number: null,
  installed_on: null,
  filter_size: null,
  purchase_price: null,
  expected_life_years: null,
  condition: null,
  last_serviced_on: null,
  created_by: null,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

/**
 * A chainable PostgREST stub. Every filter/order/limit returns the same chain;
 * `maybeSingle()` and awaiting the chain both resolve to the table's scripted
 * reply, which is exactly the surface `loadAssetDetail` uses.
 */
function client(replies: Record<string, Reply>, opts: { reject?: string } = {}): SupabaseClient<Database> {
  return {
    from: (table: string) => {
      const reply = replies[table] ?? { data: [], error: null, count: null };
      const settled = opts.reject === table
        ? Promise.reject(new Error('fetch failed'))
        : Promise.resolve(reply);
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        is: () => chain,
        in: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: () => settled,
        then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => settled.then(onF, onR),
      };
      return chain;
    },
  } as unknown as SupabaseClient<Database>;
}

const OK_BATCH: Record<string, Reply> = {
  home_assets: { data: ASSET_ROW, error: null },
  home_warranties: { data: [], error: null },
  documents: { data: [], error: null },
  home_service_records: { data: [], error: null },
  maintenance_tasks: { data: [], error: null },
  home_projects: { data: [], error: null },
};

describe('loadAssetDetail read boundary', () => {
  afterEach(() => vi.restoreAllMocks());

  it('fails closed and logs when the asset read errors', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await loadAssetDetail(
      client({ ...OK_BATCH, home_assets: { data: null, error: { message: 'permission denied for table home_assets' } } }),
      { familyId: 'fam-1', assetId: 'asset-1' },
    );

    expect(result.status).toBe('error');
    expect(result).toMatchObject({ reason: 'permission denied for table home_assets' });
    expect(err.mock.calls.map((c) => String(c[0]))).toContain('[home/asset-detail] asset read failed');
  });

  it('reports not found for an asset that is missing or belongs to another family', async () => {
    // maybeSingle answers { data: null, error: null } when the family-scoped
    // filter matches nothing — that is a 404, not a failed read, and it must not
    // be reported as one.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await loadAssetDetail(
      client({ ...OK_BATCH, home_assets: { data: null, error: null } }),
      { familyId: 'fam-1', assetId: 'not-mine' },
    );

    expect(result.status).toBe('not_found');
    expect(err).not.toHaveBeenCalled();
  });

  for (const table of ['home_warranties', 'documents', 'home_service_records', 'maintenance_tasks', 'home_projects']) {
    it(`fails closed and logs when the ${table} read errors, instead of an empty panel`, async () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {});
      const result = await loadAssetDetail(
        client({ ...OK_BATCH, [table]: { data: null, error: { message: `relation ${table} unavailable` } } }),
        { familyId: 'fam-1', assetId: 'asset-1' },
      );

      expect(result.status).toBe('error');
      expect(result).toMatchObject({ reason: `relation ${table} unavailable` });
      expect(err.mock.calls.map((c) => String(c[0]))).toContain(`[home/asset-detail] ${table} read failed`);
    });
  }

  it('survives a transport rejection in the batch and still fails closed', async () => {
    // settleAll turns a rejection into { data: null, error } so one unreachable
    // table degrades like a query error rather than rejecting the page.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await loadAssetDetail(
      client(OK_BATCH, { reject: 'maintenance_tasks' }),
      { familyId: 'fam-1', assetId: 'asset-1' },
    );

    expect(result.status).toBe('error');
    expect(err.mock.calls.map((c) => String(c[0]))).toContain('[home/asset-detail] maintenance_tasks read failed');
  });

});

describe('loadAssetDetail happy path', () => {
  afterEach(() => vi.restoreAllMocks());

  it('composes the detail from the rows it read and logs nothing', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await loadAssetDetail(
      client({
        ...OK_BATCH,
        documents: {
          data: [{
            id: 'doc-1', family_id: 'fam-1', title: 'heater-manual.pdf', category: 'manual',
            storage_path: 'fam-1/manuals/asset-1/heater-manual.pdf', mime_type: 'application/pdf',
            size_bytes: 10, expires_at: null, member_id: null, asset_id: 'asset-1',
            is_favorite: false, is_secure: false, created_by: null,
            created_at: '2026-02-01T00:00:00Z', updated_at: '2026-02-01T00:00:00Z',
          }],
          error: null,
        },
        home_projects: {
          data: [{
            id: 'proj-1', family_id: 'fam-1', title: 'Insulate the basement', description: null,
            room: 'basement', kind: 'upgrade', status: 'planning', priority: 'medium', is_diy: true,
            budget_cents: null, labor_cents: 0, target_start: null, target_end: null,
            completed_at: null, owner_id: null, contractor_id: null, photo_path: null, notes: null,
            created_by: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
          }],
          error: null,
        },
      }),
      { familyId: 'fam-1', assetId: 'asset-1', today: '2026-06-01' },
    );

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.detail.asset.id).toBe('asset-1');
    expect(result.detail.manuals.map((d) => d.title)).toEqual(['heater-manual.pdf']);
    // The asset's own warranty_until stands in when no warranty row exists.
    expect(result.detail.coverage).toMatchObject({ source: 'home_assets', state: 'active' });
    expect(result.detail.relatedProjects.map((p) => p.id)).toEqual(['proj-1']);
    expect(err).not.toHaveBeenCalled();
  });
});

// These controls use actual row filtering. The scripted replies above remain
// useful for transport/error cases, but cannot establish a family boundary.
type BoundaryRow = Record<string, unknown>;
type BoundaryPredicate = { op: 'eq' | 'is' | 'in'; column: string; value: unknown };
type BoundaryQuery = {
  table: string;
  selection: string | null;
  predicates: BoundaryPredicate[];
  orders: { column: string; options: unknown }[];
  limit: number | null;
  terminals: string[];
};
const boundaryClients: { violations: string[] }[] = [];

function filteringClient(rows: Record<string, BoundaryRow[]>) {
  const calls: BoundaryQuery[] = [];
  const violations: string[] = [];
  boundaryClients.push({ violations });
  const db = {
    from(table: string) {
      const query: BoundaryQuery = { table, selection: null, predicates: [], orders: [], limit: null, terminals: [] };
      calls.push(query);
      if (!Object.hasOwn(rows, table)) violations.push(`Unexpected table: ${table}`);
      const read = (terminal: 'await' | 'maybeSingle'): Reply => {
        query.terminals.push(terminal);
        if (query.terminals.length !== 1) violations.push(`Repeated read: ${table}`);
        const selected = (rows[table] ?? []).filter((row) => query.predicates.every(({ op, column, value }) => {
          if (!Object.hasOwn(row, column)) return false;
          return op === 'in' ? Array.isArray(value) && value.includes(row[column]) : row[column] === value;
        }));
        const data = query.limit === null ? selected : selected.slice(0, query.limit);
        if (terminal === 'maybeSingle') {
          if (data.length > 1) return { data: null, error: { message: 'Multiple rows in modeled maybeSingle' } };
          return { data: data[0] ?? null, error: null };
        }
        return { data, error: null };
      };
      const chain = {
        select(selection: string) { query.selection = selection; return chain; },
        eq(column: string, value: unknown) { query.predicates.push({ op: 'eq', column, value }); return chain; },
        is(column: string, value: unknown) { query.predicates.push({ op: 'is', column, value }); return chain; },
        in(column: string, value: unknown) {
          if (!Array.isArray(value)) violations.push(`Invalid in predicate: ${table}.${column}`);
          query.predicates.push({ op: 'in', column, value });
          return chain;
        },
        // Ordering is recorded, not emulated; these finite controls stay below
        // the history cap and do not claim PostgreSQL sort/null semantics.
        order(column: string, options?: unknown) { query.orders.push({ column, options }); return chain; },
        limit(value: number) {
          if (!Number.isInteger(value) || value < 0) violations.push(`Invalid limit: ${table}`);
          query.limit = value;
          return chain;
        },
        maybeSingle() { return Promise.resolve(read('maybeSingle')); },
        then(onF: (value: Reply) => unknown, onR?: (error: unknown) => unknown) {
          return Promise.resolve(read('await')).then(onF, onR);
        },
      };
      return chain;
    },
  } as unknown as SupabaseClient<Database>;
  return { db, calls };
}

function boundaryRows(): Record<string, BoundaryRow[]> {
  const panels: Record<string, BoundaryRow> = {
    home_warranties: {
      id: 'own-warranty', family_id: 'fam-1', asset_id: 'asset-1', deleted_at: null,
      name: 'Heater cover', provider: null, warranty_type: null, expires_on: '2029-01-01', claim_phone: null,
    },
    documents: {
      id: 'own-manual', family_id: 'fam-1', asset_id: 'asset-1', title: 'Manual', category: 'manual',
      storage_path: 'fam-1/manual.pdf', size_bytes: 10, expires_at: null, created_at: '2026-01-01T00:00:00Z',
    },
    home_service_records: {
      id: 'own-service', family_id: 'fam-1', asset_id: 'asset-1', deleted_at: null,
      title: 'Annual service', service_date: '2026-01-01', provider: null, cost: null, description: null, next_due_on: null,
    },
    maintenance_tasks: {
      id: 'own-task', family_id: 'fam-1', asset_id: 'asset-1', title: 'Inspect heater',
      status: 'todo', priority: 'medium', due_at: '2026-07-01T00:00:00Z',
    },
    home_projects: {
      id: 'own-project', family_id: 'fam-1', title: 'Insulate basement', room: 'Basement',
      status: 'planning', priority: 'medium', target_start: null, target_end: null, updated_at: '2026-01-01T00:00:00Z',
    },
  };
  const rows: Record<string, BoundaryRow[]> = {
    home_assets: [ASSET_ROW, { ...ASSET_ROW, id: 'not-mine', family_id: 'fam-2' }],
  };
  for (const [table, own] of Object.entries(panels)) {
    rows[table] = [{ ...own, id: `foreign-${table}`, family_id: 'fam-2' }, own];
    if (table !== 'home_projects') rows[table].push({ ...own, id: `other-asset-${table}`, asset_id: 'asset-2' });
  }
  rows.home_warranties.push({ ...panels.home_warranties, id: 'deleted-warranty', deleted_at: '2026-01-01T00:00:00Z' });
  rows.home_service_records.push({ ...panels.home_service_records, id: 'deleted-service', deleted_at: '2026-01-01T00:00:00Z' });
  rows.maintenance_tasks.push({ ...panels.maintenance_tasks, id: 'closed-task', status: 'done' });
  rows.home_projects.push(
    { ...panels.home_projects, id: 'other-room-project', room: 'Kitchen' },
    { ...panels.home_projects, id: 'completed-project', status: 'completed' },
  );
  return rows;
}

function expectAssetQuery(calls: BoundaryQuery[], assetId: string) {
  expect(calls[0]).toEqual({
    table: 'home_assets', selection: '*',
    predicates: [{ op: 'eq', column: 'id', value: assetId }, { op: 'eq', column: 'family_id', value: 'fam-1' }],
    orders: [], limit: null, terminals: ['maybeSingle'],
  });
}

describe('loadAssetDetail with adversarial family and asset rows', () => {
  afterEach(() => {
    // settle/settleAll catch query rejections, so adapter violations must be
    // asserted here, outside every product error-handling boundary.
    const violations = boundaryClients.splice(0).flatMap((entry) => entry.violations);
    try {
      expect(violations).toEqual([]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('refuses an existing foreign-family asset without querying panels', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db, calls } = filteringClient(boundaryRows());
    const result = await loadAssetDetail(db, { familyId: 'fam-1', assetId: 'not-mine', today: '2026-06-01' });
    expect(result).toEqual({ status: 'not_found' });
    expect(calls).toHaveLength(1);
    expectAssetQuery(calls, 'not-mine');
    expect(err).not.toHaveBeenCalled();
  });

  it('reports a genuinely missing asset without querying panels', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db, calls } = filteringClient(boundaryRows());
    const result = await loadAssetDetail(db, { familyId: 'fam-1', assetId: 'absent', today: '2026-06-01' });
    expect(result).toEqual({ status: 'not_found' });
    expect(calls).toHaveLength(1);
    expectAssetQuery(calls, 'absent');
    expect(err).not.toHaveBeenCalled();
  });

  it('assembles only the requested family asset and its scoped panels', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db, calls } = filteringClient(boundaryRows());
    const result = await loadAssetDetail(db, { familyId: 'fam-1', assetId: 'asset-1', today: '2026-06-01' });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.detail.asset).toMatchObject({ id: 'asset-1', family_id: 'fam-1' });
    expect(result.detail.coverages.map((row) => row.id)).toEqual(['own-warranty']);
    expect(result.detail.manuals.map((row) => row.id)).toEqual(['own-manual']);
    expect(result.detail.serviceHistory.map((row) => row.id)).toEqual(['own-service']);
    expect(result.detail.openMaintenance.map((row) => row.id)).toEqual(['own-task']);
    expect(result.detail.relatedProjects.map((row) => row.id)).toEqual(['own-project']);
    expect(calls.map((call) => call.table)).toEqual([
      'home_assets', 'home_warranties', 'documents', 'home_service_records', 'maintenance_tasks', 'home_projects',
    ]);
    expectAssetQuery(calls, 'asset-1');
    for (const call of calls.slice(1)) {
      expect(call.selection).toBe('*');
      expect(call.terminals).toEqual(['await']);
      expect(call.predicates).toContainEqual({ op: 'eq', column: 'family_id', value: 'fam-1' });
      if (call.table !== 'home_projects') {
        expect(call.predicates).toContainEqual({ op: 'eq', column: 'asset_id', value: 'asset-1' });
      } else {
        expect(call.predicates.some((predicate) => predicate.column === 'asset_id')).toBe(false);
      }
    }
    expect(calls[1].predicates).toContainEqual({ op: 'is', column: 'deleted_at', value: null });
    expect(calls[3].predicates).toContainEqual({ op: 'is', column: 'deleted_at', value: null });
    expect(calls[4].predicates).toContainEqual({ op: 'in', column: 'status', value: ['todo', 'in_progress'] });
    expect(calls[5].predicates).toContainEqual({
      op: 'in', column: 'status', value: ['idea', 'planning', 'quoting', 'scheduled', 'in_progress', 'on_hold'],
    });
    expect(err).not.toHaveBeenCalled();
  });
});
