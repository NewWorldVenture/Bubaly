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
