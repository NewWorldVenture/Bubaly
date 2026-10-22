// Actual dashboard actions with modeled database transport and auth/cache edges.
// These admission checks do not establish database RLS or atomic FK safety.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const boundary = vi.hoisted(() => ({ auth: vi.fn(), client: vi.fn(), cache: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: () => boundary.auth() }));
vi.mock('@/lib/supabase/server', () => ({ createServer: () => boundary.client() }));
vi.mock('next/cache', () => ({ revalidatePath: (path: string) => boundary.cache(path) }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});
const { saveWarrantyAction, saveServiceRecordAction } = await import('@/app/(app)/dashboard/home/actions');

const FAMILY = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const OWN = '44444444-4444-4444-8444-444444444444';
const FOREIGN = '55555555-5555-4555-8555-555555555555';
const MISSING = '66666666-6666-4666-8666-666666666666';
const WARRANTY = '77777777-7777-4777-8777-777777777777';
const FOREIGN_WARRANTY = '88888888-8888-4888-8888-888888888888';
const DELETED_WARRANTY = '99999999-9999-4999-8999-999999999999';
const DATE = '2026-10-16';
const TABLES = ['home_assets', 'home_warranties', 'home_service_records'];
const PATHS = [
  { name: 'warranty insert', table: 'home_warranties', update: false, call: saveWarrantyAction, page: '/dashboard/home/warranties' },
  { name: 'warranty update', table: 'home_warranties', update: true, call: saveWarrantyAction, page: '/dashboard/home/warranties' },
  { name: 'service insert', table: 'home_service_records', update: false, call: saveServiceRecordAction, page: '/dashboard/home/service' },
] as const;
type Path = typeof PATHS[number];
type ReadFault = 'returned-error' | 'thrown-error' | 'data-with-error';

function household(path: Path, options: { readFault?: ReadFault; writeFault?: boolean; bumpFault?: boolean } = {}) {
  const db = createInMemorySupabase({ defaults: { home_warranties: { deleted_at: null }, home_service_records: { deleted_at: null } } });
  db.seed('home_assets', [
    { id: OWN, family_id: FAMILY, name: 'Furnace', last_serviced_on: '2026-09-01' },
    { id: FOREIGN, family_id: OTHER, name: 'Other furnace', last_serviced_on: '2026-09-02' },
  ]);
  db.seed('home_warranties', [
    { id: WARRANTY, family_id: FAMILY, name: 'Existing warranty', asset_id: OWN, deleted_at: null },
    { id: FOREIGN_WARRANTY, family_id: OTHER, name: 'Other warranty', asset_id: FOREIGN, deleted_at: null },
    { id: DELETED_WARRANTY, family_id: FAMILY, name: 'Deleted warranty', asset_id: OWN, deleted_at: '2026-09-01T00:00:00Z' },
  ]);
  const writes: { table: string; kind: string; payload: unknown; filters: Record<string, unknown> }[] = [];
  const reads: { columns: string | undefined; filters: Record<string, unknown> }[] = [];
  const events: string[] = [];
  const refused = {
    data: null, error: { code: '42501', message: 'private-detail-must-not-leak', details: null, hint: null },
    count: null, status: 403, statusText: 'Forbidden',
  };
  const from = db.from.bind(db);
  vi.spyOn(db, 'from').mockImplementation((table) => {
    const builder = from(table);
    let writing = false;
    const filters: Record<string, unknown> = {};
    let columns: string | undefined;
    const eq = builder.eq.bind(builder);
    vi.spyOn(builder, 'eq').mockImplementation((key, value) => { filters[key] = value; return eq(key, value); });
    const is = builder.is.bind(builder);
    vi.spyOn(builder, 'is').mockImplementation((key, value) => { filters[key] = value; return is(key, value); });
    const select = builder.select.bind(builder);
    vi.spyOn(builder, 'select').mockImplementation((projection, opts) => { columns = projection; return select(projection, opts); });
    const insert = builder.insert.bind(builder);
    vi.spyOn(builder, 'insert').mockImplementation((rows) => {
      writing = true;
      writes.push({ table, kind: 'insert', payload: structuredClone(rows), filters });
      events.push(`write:${table}`);
      return insert(rows);
    });
    const update = builder.update.bind(builder);
    vi.spyOn(builder, 'update').mockImplementation((patch) => {
      writing = true;
      writes.push({ table, kind: 'update', payload: structuredClone(patch), filters });
      events.push(`write:${table}`);
      return update(patch);
    });
    const failWrite = () => writing && (table === path.table && options.writeFault || table === 'home_assets' && options.bumpFault);
    const then = builder.then.bind(builder);
    builder.then = (resolve, reject) => failWrite() ? Promise.resolve(refused).then(resolve, reject) : then(resolve, reject);
    const single = builder.single.bind(builder);
    vi.spyOn(builder, 'single').mockImplementation(() => failWrite() ? Promise.resolve(refused) : single());
    const maybeSingle = builder.maybeSingle.bind(builder);
    vi.spyOn(builder, 'maybeSingle').mockImplementation(async () => {
      if (table !== 'home_assets' || writing) return maybeSingle();
      reads.push({ columns, filters: { ...filters } });
      events.push('read:home_assets');
      if (options.readFault === 'thrown-error') throw new Error('private-detail-must-not-leak');
      if (options.readFault) return { ...refused, data: options.readFault === 'data-with-error' ? { id: OWN } : null };
      return maybeSingle();
    });
    return builder;
  });
  boundary.client.mockResolvedValue(db);
  const snapshot = () => Object.fromEntries(TABLES.map((table) => [table, structuredClone(db.table(table))]));
  const before = snapshot();
  const call = (assetId: string | null = OWN, overrides: Record<string, string> = {}) => {
    const fd = new FormData();
    const fields = { name: 'Updated warranty', title: 'Annual service', service_date: DATE, ...(path.update ? { id: WARRANTY } : {}), ...overrides };
    for (const [key, value] of Object.entries(fields)) fd.set(key, value);
    if (assetId !== null) fd.set('asset_id', assetId);
    return path.call(fd);
  };
  return { db, reads, writes, events, snapshot, before, call };
}

function unchanged(h: ReturnType<typeof household>) {
  expect(h.writes).toEqual([]);
  expect(h.snapshot()).toEqual(h.before);
  expect(boundary.cache).not.toHaveBeenCalled();
}
function cacheFor(path: Path, assetId: string | null) {
  expect(boundary.cache.mock.calls).toEqual([
    [path.page], ['/dashboard/home'], ...(assetId ? [[`/dashboard/home/assets/${assetId}`]] : []),
  ]);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-17T02:00:00Z'));
  boundary.auth.mockResolvedValue({
    user: { id: USER }, memberships: [],
    active: { familyId: FAMILY, role: 'parent', family: { id: FAMILY, timezone: 'America/Los_Angeles' }, member: { id: USER, family_id: FAMILY } },
  });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No network in this fixture'); }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe.each(PATHS)('$name checks the linked asset before saving', (path) => {
  it.each([['foreign', FOREIGN], ['missing', MISSING]])('refuses a %s asset with no write, bump or revalidation', async (_kind, assetId) => {
    const h = household(path);
    await expect(h.call(assetId)).rejects.toMatchObject({ digest: 'ACTION_REFUSED:invalid' });
    expect(h.reads).toEqual([{ columns: 'id', filters: { id: assetId, family_id: FAMILY } }]);
    unchanged(h);
  });

  it.each<ReadFault>(['returned-error', 'thrown-error', 'data-with-error'])('refuses %s without treating it as a saved asset', async (readFault) => {
    const h = household(path, { readFault });
    const result = await h.call().then(() => null, (error: unknown) => error);
    expect(result).toBeInstanceOf(Error);
    expect(result).toHaveProperty('digest');
    expect(String(result)).not.toContain('private-detail-must-not-leak');
    expect(h.reads).toEqual([{ columns: 'id', filters: { id: OWN, family_id: FAMILY } }]);
    unchanged(h);
  });

  it('preserves a healthy same-family linked save and its cache paths', async () => {
    const h = household(path);
    await expect(h.call()).resolves.toBeUndefined();
    const saved = h.db.table(path.table).find((row) => path.update ? row.id === WARRANTY : !h.before[path.table].some((old) => old.id === row.id));
    expect(saved).toMatchObject({ family_id: FAMILY, asset_id: OWN, ...(path.update ? { updated_by: USER } : { created_by: USER }) });
    expect(h.writes[0]).toMatchObject({ table: path.table, kind: path.update ? 'update' : 'insert' });
    if (path.update) expect(h.writes[0].filters).toEqual({ id: WARRANTY, family_id: FAMILY, deleted_at: null });
    expect(h.db.table('home_assets')[1]).toEqual(h.before.home_assets[1]);
    if (path.table === 'home_service_records') expect(h.db.table('home_assets')[0].last_serviced_on).toBe(DATE);
    cacheFor(path, OWN);
  });

  it('allows an unlinked save without an asset read or asset update', async () => {
    const h = household(path, { readFault: 'thrown-error' });
    await expect(h.call(null)).resolves.toBeUndefined();
    expect(h.reads).toEqual([]);
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0].payload).toMatchObject({ asset_id: null });
    expect(h.db.table('home_assets')).toEqual(h.before.home_assets);
    cacheFor(path, null);
  });

  it('requires authentication before creating a client or touching any row', async () => {
    const h = household(path);
    boundary.auth.mockRejectedValueOnce(new Error('Authentication required'));
    await expect(h.call()).rejects.toThrow('Authentication required');
    expect(boundary.client).not.toHaveBeenCalled();
    expect(h.reads).toEqual([]);
    unchanged(h);
  });

  it('preserves a child-write refusal with no persisted row, bump or cache change', async () => {
    const h = household(path, { writeFault: true });
    await expect(h.call()).rejects.toMatchObject({ digest: 'ACTION_REFUSED:notAllowed' });
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0].table).toBe(path.table);
    expect(h.snapshot()).toEqual(h.before);
    expect(boundary.cache).not.toHaveBeenCalled();
  });
});

describe('warranty destination and service-date controls', () => {
  it.each([['foreign', FOREIGN_WARRANTY], ['deleted', DELETED_WARRANTY], ['missing', MISSING]])('does not save an update to a %s warranty', async (_kind, id) => {
    const h = household(PATHS[1]);
    await expect(h.call(OWN, { id })).rejects.toThrow();
    expect(h.writes).toHaveLength(1);
    expect(h.writes[0]).toMatchObject({ table: 'home_warranties', kind: 'update', filters: { id, family_id: FAMILY, deleted_at: null } });
    expect(h.snapshot()).toEqual(h.before);
    expect(boundary.cache).not.toHaveBeenCalled();
  });

  it('keeps a backdated service in history without moving the asset date backwards', async () => {
    const h = household(PATHS[2]);
    await h.call(OWN, { service_date: '2024-01-01' });
    expect(h.db.table('home_service_records')[0].service_date).toBe('2024-01-01');
    expect(h.db.table('home_assets')).toEqual(h.before.home_assets);
    expect(console.error).not.toHaveBeenCalled();
    cacheFor(PATHS[2], OWN);
  });

  it('uses the family day for a blank date without bumping the asset', async () => {
    const h = household(PATHS[2]);
    await h.call(OWN, { service_date: '' });
    expect(h.db.table('home_service_records')[0].service_date).toBe(DATE);
    expect(h.writes).toHaveLength(1);
    expect(h.db.table('home_assets')).toEqual(h.before.home_assets);
    cacheFor(PATHS[2], OWN);
  });

  it('keeps an acknowledged service save when the later best-effort asset bump fails', async () => {
    const h = household(PATHS[2], { bumpFault: true });
    await expect(h.call()).resolves.toBeUndefined();
    expect(h.db.table('home_service_records')).toEqual([expect.objectContaining({ asset_id: OWN, family_id: FAMILY, service_date: DATE })]);
    expect(h.db.table('home_assets')).toEqual(h.before.home_assets);
    expect(h.writes.map((write) => write.table)).toEqual(['home_service_records', 'home_assets']);
    expect(console.error).toHaveBeenCalledTimes(1);
    cacheFor(PATHS[2], OWN);
  });
});
