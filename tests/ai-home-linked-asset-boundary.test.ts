// Real registry, trust gate, tool ledger and Home services; only database
// transport is modeled. Admission checks do not establish RLS or atomic FK safety.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

type DB = SupabaseClient<Database>;
const server = vi.hoisted(() => ({ client: null as DB | null }));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => {
    if (!server.client) throw new Error('No test ledger client');
    return server.client;
  },
}));

const { toToolSpecs } = await import('@/lib/ai/tools/legacy-adapter');
const { createServiceRecord, createMaintenanceTask } = await import('@/lib/services/home');

const FAMILY = 'family-home-owner';
const OWN = 'asset-own';
const FOREIGN = 'asset-foreign';
const DATE = '2026-10-16';
const DOMAIN_TABLES = ['home_assets', 'home_contractors', 'home_service_records', 'maintenance_tasks', 'agent_activity'];
const TOOLS = [
  { name: 'home.createServiceRecord', table: 'home_service_records', title: 'Annual furnace service' },
  { name: 'home.createMaintenanceTask', table: 'maintenance_tasks', title: 'Replace furnace filter' },
] as const;
type Tool = typeof TOOLS[number];
type Fault = 'returned-error' | 'thrown-error' | 'data-with-error';

function household(tool: Tool, options: { fault?: Fault; enabled?: boolean; replay?: boolean } = {}) {
  const db = createInMemorySupabase({
    defaults: {
      home_service_records: { deleted_at: null, metadata: {} },
      maintenance_tasks: { status: 'todo', due_at: null, assignee_id: null, asset_id: null },
    },
    uniques: { ai_tool_calls: [['family_id', 'idempotency_key']] },
  });
  db.seed('home_assets', [
    { id: OWN, family_id: FAMILY, name: 'Furnace', last_serviced_on: '2026-09-01' },
    { id: FOREIGN, family_id: 'other-family', name: 'Private boiler', last_serviced_on: '2026-09-02' },
  ]);
  db.seed('home_contractors', [{
    id: 'contractor-own', family_id: FAMILY, name: 'Family plumber', deleted_at: null, last_used_on: '2026-09-01',
  }]);
  db.seed('family_ai_settings', [{ family_id: FAMILY, enabled: options.enabled ?? true, behavior: 'execute' }]);

  const writes: { table: string; kind: string; payload: unknown }[] = [];
  const reads: { filters: Record<string, unknown>; columns: string | undefined }[] = [];
  const from = db.from.bind(db);
  vi.spyOn(db, 'from').mockImplementation((table) => {
    const builder = from(table);
    if (!DOMAIN_TABLES.includes(table)) return builder;
    let writing = false;
    const insert = builder.insert.bind(builder);
    vi.spyOn(builder, 'insert').mockImplementation((rows) => {
      writing = true;
      writes.push({ table, kind: 'insert', payload: structuredClone(rows) });
      return insert(rows);
    });
    const update = builder.update.bind(builder);
    vi.spyOn(builder, 'update').mockImplementation((patch) => {
      writing = true;
      writes.push({ table, kind: 'update', payload: structuredClone(patch) });
      return update(patch);
    });
    if (table !== 'home_assets') return builder;
    const filters: Record<string, unknown> = {};
    let columns: string | undefined;
    const eq = builder.eq.bind(builder);
    vi.spyOn(builder, 'eq').mockImplementation((key, value) => {
      filters[key] = value;
      return eq(key, value);
    });
    const select = builder.select.bind(builder);
    vi.spyOn(builder, 'select').mockImplementation((projection, opts) => {
      columns = projection;
      return select(projection, opts);
    });
    const maybeSingle = builder.maybeSingle.bind(builder);
    vi.spyOn(builder, 'maybeSingle').mockImplementation(async () => {
      if (writing) return maybeSingle();
      reads.push({ filters: { ...filters }, columns });
      if (!options.fault) return maybeSingle();
      if (options.fault === 'thrown-error') throw new Error('Synthetic asset transport unavailable');
      return {
        data: options.fault === 'data-with-error' ? { id: OWN } : null,
        error: { code: '42501', message: 'Synthetic asset lookup refused', details: null, hint: null },
        count: null, status: 403, statusText: 'Forbidden',
      };
    });
    return builder;
  });
  const client = db as unknown as DB;
  server.client = client;
  const scope: ServiceScope = {
    db: client, familyId: FAMILY, userId: 'auth-parent', memberId: 'member-parent',
    role: 'parent', actorKind: 'ai', tz: 'UTC', now: new Date(`${DATE}T12:00:00Z`),
    requestId: options.replay ? 'request-asset-retry' : null,
  };
  const spec = toToolSpecs(scope, { names: [tool.name] })[0];
  const snapshot = () => Object.fromEntries(DOMAIN_TABLES.map((table) => [table, structuredClone(db.table(table))]));
  const before = snapshot();
  const args = (assetId?: string) => ({
    title: tool.title,
    ...(assetId === undefined ? {} : { asset_id: assetId }),
    ...(tool.table === 'home_service_records' ? { service_date: DATE, contractor_id: 'contractor-own' } : {}),
  });
  const direct = (assetId: string, retry = false) => {
    const serviceScope = retry ? { ...scope, runId: 'run-asset-retry' } : scope;
    return tool.table === 'home_service_records'
      ? createServiceRecord(serviceScope, { title: tool.title, serviceDate: DATE, assetId, contractorId: 'contractor-own' })
      : createMaintenanceTask(serviceScope, { title: tool.title, assetId });
  };
  return {
    db, writes, reads, before, snapshot, direct,
    makeAssetUnreadable: () => { options.fault = 'thrown-error'; },
    call: (assetId?: string) => spec.execute(args(assetId)),
  };
}

function expectNoHomeWrite(h: ReturnType<typeof household>) {
  expect(h.writes).toEqual([]);
  expect(h.snapshot()).toEqual(h.before);
  // Trust decisions and failed tool receipts can be recorded, but no committed
  // Home change should be described on either activity surface.
  expect(h.db.table('audit_logs').filter((row) => row.resource === 'home')).toEqual([]);
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('This fixture may not use the network'); }));
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  server.client = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe.each(TOOLS)('$name admits only a saved same-family linked asset', (tool) => {
  it.each([['foreign', FOREIGN], ['missing', 'asset-missing']])('refuses a %s asset before any Home write', async (_kind, assetId) => {
    const h = household(tool);
    expect(await h.call(assetId)).toMatchObject({ ok: false });
    expect(h.reads).toEqual([{ columns: 'id', filters: { id: assetId, family_id: FAMILY } }]);
    expectNoHomeWrite(h);
    expect(h.db.table('ai_tool_calls')).toEqual([expect.objectContaining({ tool_name: tool.name, state: 'failed' })]);
  });

  it.each<Fault>(['returned-error', 'thrown-error', 'data-with-error'])('fails closed on an asset %s', async (fault) => {
    const h = household(tool, { fault });
    expect(await h.call(OWN)).toMatchObject({ ok: false });
    expect(h.reads).toEqual([{ columns: 'id', filters: { id: OWN, family_id: FAMILY } }]);
    expectNoHomeWrite(h);
    expect(h.db.table('ai_tool_calls')).toEqual([expect.objectContaining({ tool_name: tool.name, state: 'failed' })]);
  });

  it('returns a service failure for a thrown asset read without relying on the tool catch', async () => {
    const h = household(tool, { fault: 'thrown-error' });
    await expect(h.direct(OWN)).resolves.toMatchObject({ ok: false, code: 'db' });
    expect(h.reads).toHaveLength(1);
    expectNoHomeWrite(h);
    expect(h.db.table('ai_tool_calls')).toEqual([]);
  });

  it('saves the family asset link and preserves the ordinary activity and date updates', async () => {
    const h = household(tool);
    expect(await h.call(OWN)).toMatchObject({ ok: true, data: { id: expect.any(String), title: tool.title } });
    expect(h.db.table(tool.table)).toEqual([expect.objectContaining({ family_id: FAMILY, asset_id: OWN, title: tool.title })]);
    expect(h.db.table('agent_activity')).toHaveLength(1);
    expect(h.db.table('audit_logs').filter((row) => row.resource === 'home')).toHaveLength(1);
    expect(h.db.table('home_assets').find((row) => row.id === FOREIGN)).toEqual(h.before.home_assets[1]);
    if (tool.table === 'home_service_records') {
      expect(h.db.table('home_assets').find((row) => row.id === OWN)?.last_serviced_on).toBe(DATE);
      expect(h.db.table('home_contractors')[0].last_used_on).toBe(DATE);
      expect(h.writes.filter((write) => write.kind === 'update').map((write) => write.table)).toEqual(['home_assets', 'home_contractors']);
    } else {
      expect(h.writes.filter((write) => write.kind === 'update')).toEqual([]);
      expect(h.db.table('home_assets')).toEqual(h.before.home_assets);
    }
    expect(h.db.table('ai_tool_calls')).toEqual([expect.objectContaining({ state: 'succeeded', resource_table: tool.table })]);
  });

  it('still saves a request without a linked asset even if asset reads would fail', async () => {
    const h = household(tool, { fault: 'thrown-error' });
    expect(await h.call()).toMatchObject({ ok: true });
    expect(h.reads).toEqual([]);
    expect(h.db.table(tool.table)).toEqual([expect.objectContaining({ family_id: FAMILY, asset_id: null })]);
    expect(h.db.table('home_assets')).toEqual(h.before.home_assets);
    expect(h.db.table('agent_activity')).toHaveLength(1);
  });

  it('returns an already saved service result when a subsequent asset read would fail', async () => {
    const h = household(tool);
    const first = await h.direct(OWN, true);
    expect(first).toMatchObject({ ok: true });
    // Keep the persisted rows intact. Real asset deletion uses ON DELETE SET
    // NULL, which this transport model does not simulate.
    h.makeAssetUnreadable();
    const afterSave = h.snapshot();
    const writes = h.writes.length;
    const reads = h.reads.length;
    expect(await h.direct(OWN, true)).toEqual(first);
    expect(h.snapshot()).toEqual(afterSave);
    expect(h.writes).toHaveLength(writes);
    expect(h.reads).toHaveLength(reads);
    expect(h.db.table(tool.table)).toHaveLength(1);
  });

  it('replays the successful tool receipt without a new asset read or Home write', async () => {
    const h = household(tool, { replay: true });
    const first = await h.call(OWN);
    expect(first).toMatchObject({ ok: true });
    h.makeAssetUnreadable();
    const afterSave = h.snapshot();
    const writes = h.writes.length;
    const reads = h.reads.length;
    const replay = await h.call(OWN);
    expect(replay).toMatchObject({ ok: true });
    expect(replay).toMatchObject({ data: expect.objectContaining({ title: tool.title }) });
    expect(h.db.table(tool.table)).toHaveLength(1);
    expect(h.snapshot()).toEqual(afterSave);
    expect(h.writes).toHaveLength(writes);
    expect(h.reads).toHaveLength(reads);
    expect(h.db.table('ai_tool_calls')).toHaveLength(1);
  });

  it('keeps the real disabled-settings gate ahead of asset admission', async () => {
    const h = household(tool, { enabled: false });
    expect(await h.call(OWN)).toMatchObject({ ok: false });
    expect(h.reads).toEqual([]);
    expectNoHomeWrite(h);
  });
});
