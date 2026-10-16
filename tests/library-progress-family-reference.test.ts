// Real server action and schema; synthetic auth/client/cache boundaries only.
// This models 0284's explicit FK/RLS/conflict rules, not native or live SQL.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { saveProgressAction } from '@/app/(app)/dashboard/library/actions';

const h = vi.hoisted(() => ({ db: null as unknown, family: '', user: '', role: 'parent',
  authError: null as unknown, clientError: null as unknown, auth: vi.fn(), client: vi.fn(), refresh: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => {
  h.auth(); if (h.authError) throw h.authError;
  return { user: { id: h.user }, active: { familyId: h.family, role: h.role } };
} }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => {
  h.client(); if (h.clientError) throw h.clientError; return h.db;
} }));
vi.mock('next/cache', () => ({ revalidatePath: h.refresh }));

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const U = '11111111-1111-4111-8111-111111111111';
const V = '22222222-2222-4222-8222-222222222222';
const OWN = 'a1b2c3d4-e5f6-4789-abcd-0123456789ab';
const FOREIGN = 'b1b2c3d4-e5f6-4789-abcd-0123456789ab';
const MISSING = 'c1b2c3d4-e5f6-4789-abcd-0123456789ab';
const NOW = '2026-10-16T12:00:00.000Z';
const PRIVATE = 'synthetic private lookup detail';
const REFUSAL = { ok: false, error: 'Could not save your place.' };
const SAVED = { ok: true, message: 'Saved.' };
type Input = Parameters<typeof saveProgressAction>[0];
type Fault = 'none' | 'returned' | 'codeless' | 'data-error' | 'throw' | 'reject';
let db: InMemorySupabase;
let lookupFault: Fault;
let receipt: { value: unknown } | null;
let writeFault: 'none' | 'returned' | 'throw';
let violations: string[];
let calls: { table: string; op: string; filters?: [string, unknown][]; payload?: Row; options?: unknown }[];
let policy: { oldUsing: boolean | null; newCheck: boolean; foreignKey: boolean }[];
let admissions: number;
let writes: number;
let network: ReturnType<typeof vi.fn>;
const fail = () => ({ code: '42501', message: PRIVATE, details: PRIVATE, hint: PRIVATE });
function forbidden(message: string): never { violations.push(message); throw new Error(message); }
function strictMethods<T extends object>(target: T): T {
  return new Proxy(target, { get(object, property, receiver) {
    if (typeof property === 'string' && !(property in object)) return forbidden(`Unexpected query method ${property}`);
    return Reflect.get(object, property, receiver);
  } });
}

// Declared PostgreSQL UUID representation boundary: canonical-hyphenated UUIDs
// compare case-insensitively and are stored lowercase. Request bytes are logged
// before normalization. This includes upsert's conflict key, not just SELECT.
function canonical(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    return forbidden('Unexpected non-UUID at declared database boundary');
  }
  return value.toLowerCase();
}
function member(family: string, user = h.user): boolean {
  return db.table('family_members').some(m => m.family_id === canonical(family) && m.user_id === canonical(user) && m.is_active === true);
}
function strictClient() {
  return {
    from(table: string) {
      if (table === 'library_items') {
        let projection = '';
        const filters: [string, unknown][] = [];
        calls.push({ table, op: 'select', filters });
        const query = {
          select(columns: string) { projection = columns; return this; },
          eq(key: string, value: unknown) { filters.push([key, value]); return this; },
          maybeSingle() {
            admissions += 1;
            if (projection !== 'id, family_id' || filters.length !== 2 || filters[0]?.[0] !== 'id' || filters[1]?.[0] !== 'family_id' || filters[1]?.[1] !== h.family) {
              return forbidden('Unexpected item admission query');
            }
            if (lookupFault === 'throw') throw new Error(PRIVATE);
            if (lookupFault === 'reject') return Promise.reject(new Error(PRIVATE));
            const id = canonical(filters[0][1]), family = canonical(filters[1][1]);
            const row = db.table('library_items').find(r => r.id === id && r.family_id === family && member(family));
            const data = receipt ? receipt.value : row ? { id: row.id, family_id: row.family_id } : null;
            if (lookupFault === 'returned') return Promise.resolve({ data: null, error: fail() });
            if (lookupFault === 'codeless') return Promise.resolve({ data: null, error: { message: PRIVATE } });
            if (lookupFault === 'data-error') return Promise.resolve({ data, error: fail() });
            return Promise.resolve({ data, error: null });
          },
        };
        return strictMethods(query);
      }
      if (table === 'library_progress') return strictMethods({
        async upsert(payload: Row, options: { onConflict: string }) {
          writes += 1;
          calls.push({ table, op: 'upsert', payload: { ...payload }, options: { ...options } });
          if (options.onConflict !== 'item_id,user_id' || Object.keys(options).length !== 1) forbidden('Unexpected progress conflict target');
          const allowed = ['family_id', 'item_id', 'user_id', 'updated_at', 'position_seconds', 'saved', 'offline', 'completed_at'];
          if (Object.keys(payload).some(k => !allowed.includes(k))) forbidden('Unexpected progress payload field');
          const row = { ...payload, family_id: canonical(payload.family_id), item_id: canonical(payload.item_id), user_id: canonical(payload.user_id) };
          const old = db.table('library_progress').find(r => r.item_id === row.item_id && r.user_id === row.user_id);
          // 0284: existing-row USING and new-row WITH CHECK are distinct.
          // The FK checks existence by global item id, not the item's family.
          const oldUsing = old ? member(String(old.family_id)) && old.user_id === canonical(h.user) : null;
          const newCheck = member(row.family_id) && row.user_id === canonical(h.user);
          const foreignKey = db.table('library_items').some(r => r.id === row.item_id);
          policy.push({ oldUsing, newCheck, foreignKey });
          if (writeFault === 'throw') throw new Error('synthetic write transport failure');
          if (writeFault === 'returned' || oldUsing === false || !newCheck) return { data: null, error: fail() };
          if (!foreignKey) return { data: null, error: { code: '23503', message: 'synthetic missing item' } };
          // The shared model itself supplies sparse conflict updates and the
          // no-RETURNING response; no blanket fake write success is injected.
          return await db.from('library_progress').upsert(row, options);
        },
      });
      return forbidden(`Unexpected table ${table}`);
    },
  };
}
function rows() { return db.table('library_progress'); }
function seedProgress(family = A, item = OWN, user = U) {
  db.seed('library_progress', [{ id: `progress-${family}-${user}`, family_id: family, item_id: item, user_id: user,
    position_seconds: 7200, saved: true, offline: true, completed_at: '2026-10-15T12:00:00.000Z', updated_at: '2026-10-15T12:00:00.000Z' }]);
}
function addBMembership() { db.seed('family_members', [{ id: 'member-b', family_id: B, user_id: U, is_active: true, role: h.role }]); }
async function refused(input: Input = { itemId: OWN, saved: true }) {
  const before = structuredClone(rows());
  const result = await saveProgressAction(input);
  expect(rows()).toEqual(before);
  expect(writes).toBe(0);
  expect(h.refresh).not.toHaveBeenCalled();
  expect(result).toEqual(REFUSAL);
  expect(JSON.stringify(result)).not.toContain(PRIVATE);
}

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(NOW));
  db = createInMemorySupabase({ uniques: { library_progress: [['item_id', 'user_id']] }, defaults: {
    library_progress: { position_seconds: 0, saved: false, offline: false, completed_at: null },
  } });
  db.seed('family_members', [{ id: 'member-a', family_id: A, user_id: U, is_active: true, role: 'parent' }]);
  db.seed('library_items', [{ id: OWN, family_id: A, kind: 'book' }, { id: FOREIGN, family_id: B, kind: 'episode' }]);
  h.family = A; h.user = U; h.role = 'parent'; h.authError = null; h.clientError = null;
  h.auth.mockClear(); h.client.mockClear(); h.refresh.mockClear();
  lookupFault = 'none'; writeFault = 'none'; receipt = null; violations = []; calls = []; policy = []; admissions = 0; writes = 0;
  h.db = strictClient();
  network = vi.fn(() => { throw new Error('Unexpected network'); }); vi.stubGlobal('fetch', network);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  try { expect(violations).toEqual([]); expect(network).not.toHaveBeenCalled(); }
  finally { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); }
});

describe('the active family admits the item before personal progress is written', () => {
  it('refuses a foreign existing item for a new A-only member progress row', async () => {
    expect(member(A)).toBe(true); expect(member(B)).toBe(false);
    await refused({ itemId: FOREIGN, saved: true });
  });
  it('refuses moving the same user’s B bookmark into active A when both memberships exist', async () => {
    addBMembership(); seedProgress(B, FOREIGN);
    expect(member(A)).toBe(true); expect(member(B)).toBe(true);
    await refused({ itemId: FOREIGN, positionSeconds: 12, saved: false });
  });
  it('does not credit the new guard for an existing B row already denied by the old USING policy', async () => {
    seedProgress(B, FOREIGN);
    const before = structuredClone(rows());
    expect(await saveProgressAction({ itemId: FOREIGN, saved: false })).toEqual(REFUSAL);
    expect(rows()).toEqual(before); expect(h.refresh).not.toHaveBeenCalled();
    // Original source reaches the modeled policy; guarded source never writes.
    if (writes) expect(policy).toEqual([{ oldUsing: false, newCheck: true, foreignKey: true }]);
  });
  it('refuses a missing item before attempting an upsert; native FK refusal remains distinct', async () => {
    await refused({ itemId: MISSING, saved: true });
  });
  it.each<Fault>(['returned', 'codeless', 'data-error', 'throw', 'reject'])('refuses %s lookup failure without writing or refreshing', async fault => {
    lookupFault = fault; await refused();
  });
  it.each<[string, unknown]>([
    ['null', null], ['array', [{ id: OWN, family_id: A }]], ['scalar', OWN], ['empty', {}],
    ['missing-id', { family_id: A }], ['blank-id', { id: ' ', family_id: A }], ['wrong-id', { id: FOREIGN, family_id: A }],
    ['missing-family', { id: OWN }], ['wrong-family', { id: OWN, family_id: B }], ['nonstring-id', { id: 12, family_id: A }],
  ])('refuses malformed/mismatched %s admission receipt', async (_name, value) => {
    receipt = { value }; await refused();
  });
});

describe('personal progress compatibility and explicit UUID transport semantics', () => {
  it('saves a same-family book with all requested fields and a no-RETURNING response', async () => {
    expect(await saveProgressAction({ itemId: OWN, positionSeconds: 321, saved: true, offline: true, completed: true })).toEqual(SAVED);
    expect(rows()).toEqual([expect.objectContaining({ family_id: A, item_id: OWN, user_id: U, position_seconds: 321, saved: true, offline: true, completed_at: NOW, updated_at: NOW })]);
    expect(admissions).toBe(1); expect(writes).toBe(1); expect(h.refresh).toHaveBeenCalledExactlyOnceWith('/dashboard/library');
    expect(calls.map(c => [c.table, c.op])).toEqual([['library_items', 'select'], ['library_progress', 'upsert']]);
    expect(policy).toEqual([{ oldUsing: null, newCheck: true, foreignKey: true }]);
  });
  it('updates only supplied sparse fields on an existing same-family bookmark', async () => {
    seedProgress(); const expected = { ...rows()[0], position_seconds: 44, updated_at: NOW };
    expect(await saveProgressAction({ itemId: OWN, positionSeconds: 44 })).toEqual(SAVED);
    expect(rows()).toEqual([expected]);
    expect(policy).toEqual([{ oldUsing: true, newCheck: true, foreignKey: true }]); expect(admissions).toBe(1);
  });
  it('explicit zero resets a nonzero position without clearing omitted flags', async () => {
    seedProgress(); const expected = { ...rows()[0], position_seconds: 0, updated_at: NOW };
    expect(await saveProgressAction({ itemId: OWN, positionSeconds: 0 })).toEqual(SAVED);
    expect(rows()).toEqual([expected]); expect(admissions).toBe(1);
  });
  it('explicit false flags clear only their existing fields', async () => {
    seedProgress();
    expect(await saveProgressAction({ itemId: OWN, saved: false, offline: false, completed: false })).toEqual(SAVED);
    expect(rows()[0]).toMatchObject({ position_seconds: 7200, saved: false, offline: false, completed_at: null }); expect(admissions).toBe(1);
  });
  it('an empty sparse update preserves the existing position and flags', async () => {
    seedProgress(); const before = { ...rows()[0], updated_at: NOW };
    expect(await saveProgressAction({ itemId: OWN })).toEqual(SAVED); expect(rows()).toEqual([before]); expect(admissions).toBe(1);
  });
  it.each(['parent', 'adult', 'teen', 'child', 'caregiver', 'guest'])('preserves the existing %s personal-progress behavior', async role => {
    h.role = role; db.table('family_members')[0].role = role;
    expect(await saveProgressAction({ itemId: OWN, saved: true })).toEqual(SAVED); expect(rows()).toHaveLength(1); expect(admissions).toBe(1);
  });
  it('saves an episode in B when B is actually active', async () => {
    addBMembership(); h.family = B;
    expect(await saveProgressAction({ itemId: FOREIGN, saved: true })).toEqual(SAVED);
    expect(rows()[0]).toMatchObject({ family_id: B, item_id: FOREIGN, user_id: U }); expect(admissions).toBe(1);
  });
  it('keeps another user’s existing progress unchanged', async () => {
    seedProgress(A, OWN, V); const other = structuredClone(rows()[0]);
    expect(await saveProgressAction({ itemId: OWN, positionSeconds: 50 })).toEqual(SAVED);
    expect(rows()).toHaveLength(2); expect(rows().find(r => r.user_id === V)).toEqual(other); expect(rows().find(r => r.user_id === U)?.position_seconds).toBe(50); expect(admissions).toBe(1);
  });
  it('ignores forged family/user fields through the unchanged input schema', async () => {
    expect(await saveProgressAction({ itemId: OWN, saved: true, family_id: B, user_id: V } as Input)).toEqual(SAVED);
    expect(rows()[0]).toMatchObject({ family_id: A, user_id: U, item_id: OWN }); expect(admissions).toBe(1);
  });
  it.each([false, true])('preserves uppercase item input with an existing conflict=%s', async existing => {
    if (existing) seedProgress();
    const oldId = existing ? rows()[0].id : null;
    expect(await saveProgressAction({ itemId: OWN.toUpperCase(), saved: false })).toEqual(SAVED);
    expect(rows()).toHaveLength(1); expect(rows()[0]).toMatchObject({ item_id: OWN, family_id: A, user_id: U, saved: false });
    if (existing) { expect(rows()[0].id).toBe(oldId); expect(rows()[0].position_seconds).toBe(7200); }
    expect(admissions).toBe(1); expect(calls[0].filters).toEqual([['id', OWN.toUpperCase()], ['family_id', A]]);
    expect(calls[1].payload?.item_id).toBe(OWN.toUpperCase());
  });
  it.each<unknown>([
    { itemId: '' }, { itemId: 'not-a-uuid' }, { itemId: `{${OWN}}` }, { itemId: OWN.replaceAll('-', '') },
    { itemId: OWN, positionSeconds: -1 }, { itemId: OWN, positionSeconds: 86401 }, { itemId: OWN, positionSeconds: 1.5 },
    { itemId: OWN, saved: 'true' }, {},
  ])('preserves schema refusal for %j before constructing a client', async input => {
    expect(await saveProgressAction(input as Input)).toEqual({ ok: false, error: 'Invalid progress update.' });
    expect(h.auth).toHaveBeenCalledOnce(); expect(h.client).not.toHaveBeenCalled(); expect(calls).toEqual([]); expect(h.refresh).not.toHaveBeenCalled();
  });
  it('reaches the existing returned-upsert-error boundary after valid item admission', async () => {
    writeFault = 'returned'; expect(await saveProgressAction({ itemId: OWN, saved: true })).toEqual(REFUSAL);
    expect(admissions).toBe(1); expect(writes).toBe(1); expect(rows()).toEqual([]); expect(h.refresh).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith('[library] progress save failed', expect.objectContaining({ code: '42501' }));
  });
  it('preserves a thrown upsert failure outside the new lookup catch', async () => {
    writeFault = 'throw'; await expect(saveProgressAction({ itemId: OWN })).rejects.toThrow('synthetic write transport failure');
    expect(admissions).toBe(1); expect(writes).toBe(1); expect(rows()).toEqual([]); expect(h.refresh).not.toHaveBeenCalled();
  });
  it('preserves authentication redirects', async () => {
    const error = Object.assign(new Error('redirect'), { digest: 'NEXT_REDIRECT' }); h.authError = error;
    await expect(saveProgressAction({ itemId: OWN })).rejects.toBe(error); expect(h.client).not.toHaveBeenCalled(); expect(calls).toEqual([]);
  });
  it('preserves client-construction failure outside the lookup boundary', async () => {
    const error = new Error('client unavailable'); h.clientError = error;
    await expect(saveProgressAction({ itemId: OWN })).rejects.toBe(error); expect(calls).toEqual([]); expect(h.refresh).not.toHaveBeenCalled();
  });
});
