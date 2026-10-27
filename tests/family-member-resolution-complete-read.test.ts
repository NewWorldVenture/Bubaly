// Existing name-precedence policy over a server-capped synthetic roster.
// No downstream tool execution, Auth, SDK, coordinator, Storage or database.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import type { ServiceScope } from '@/lib/services/types';

const h = vi.hoisted(() => ({ forbidden: vi.fn((name: string): never => { throw new Error(`Forbidden boundary: ${name}`); }) }));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => h.forbidden('SDK') }));
vi.mock('@supabase/ssr', () => ({ createServerClient: () => h.forbidden('SSR'), createBrowserClient: () => h.forbidden('browser client') }));
vi.mock('@/lib/supabase/server', () => ({ createServer: () => h.forbidden('server client'), createServiceClient: () => h.forbidden('service client') }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: () => h.forbidden('Auth'), getUserContext: () => h.forbidden('Auth') }));
vi.mock('@/lib/ai/provider', () => ({ resolveProvider: () => h.forbidden('provider') }));

const importFetch = vi.fn(() => h.forbidden('import fetch'));
vi.stubGlobal('fetch', importFetch);
const { resolveMemberByName } = await import('@/lib/services/family');
const { resolveAssigneeId } = await import('@/lib/ai/tools/family');
const importBoundary = { fetch: [...importFetch.mock.calls], forbidden: [...h.forbidden.mock.calls] };
const FAMILY = 'synthetic-family';
const member = (id: string, display_name: string, is_active = true, family_id = FAMILY, day = 1) => ({
  id, family_id, user_id: `synthetic-user-${id}`, display_name, role: 'teen', is_active,
  birthday: null, color: null, avatar_url: null, created_at: `2026-09-${String(day).padStart(2, '0')}T00:00:00Z`,
});
type MemberRow = ReturnType<typeof member>;
type Model = { db: InMemorySupabase; scope: ServiceScope; calls: string[]; before: string };
let models: Model[];
let fetchGuard: ReturnType<typeof vi.fn>;

function roster(rows: MemberRow[], maxRows?: number): Model {
  const db = createInMemorySupabase({ maxRows });
  db.seed('family_members', rows);
  Object.assign(db.auth, { getUser: () => h.forbidden('synthetic Auth called') });
  db.rpc = async () => h.forbidden('RPC');
  const calls: string[] = [], original = db.from.bind(db);
  db.from = ((table: string) => {
    calls.push(table);
    if (table !== 'family_members') h.forbidden(`unexpected table ${table}`);
    const target = original(table);
    const proxy = new Proxy(target, {
      get(object, property, receiver) {
        if (['insert', 'update', 'upsert', 'delete'].includes(String(property))) return () => h.forbidden(`write ${String(property)}`);
        const value: unknown = Reflect.get(object, property, receiver);
        if (typeof value !== 'function') return value;
        if (property === 'then') return value.bind(object);
        return (...args: unknown[]) => { const result: unknown = value.apply(object, args); return result === object ? proxy : result; };
      },
    });
    return proxy;
  }) as typeof db.from;
  const scope: ServiceScope = { db: db as unknown as ServiceScope['db'], familyId: FAMILY,
    userId: 'synthetic-reader', memberId: 'synthetic-reader-member', role: 'parent', actorKind: 'member',
    tz: 'UTC', now: new Date('2026-10-01T12:00:00Z') };
  const model = { db, scope, calls, before: JSON.stringify(db.table('family_members')) };
  models.push(model);
  return model;
}

async function both(model: Model, name: string | null) {
  // Obtain BOTH outcomes before asserting, so a failed service precedence
  // assertion cannot prevent the thin tool-resolver path from being driven.
  const service = await resolveMemberByName(model.scope, name);
  const assignee = await resolveAssigneeId(model.scope, { assignee: name }, { requireActive: true });
  return { service, assignee };
}
const selected = (id: string) => ({ service: { ok: true, data: { id } }, assignee: { ok: true, data: id } });

function failSecondPage(model: Model) {
  const original = model.db.from.bind(model.db);
  let reads = 0;
  model.db.from = ((table: string) => {
    if (table !== 'family_members') h.forbidden(`unexpected later-page table ${table}`);
    if (++reads !== 2) return original(table);
    const reply = { data: null, count: null, error: { code: '57014', message: 'synthetic second member page unavailable' } };
    const failed: unknown = new Proxy({}, { get(_target, key) {
      if (['insert', 'update', 'upsert', 'delete'].includes(String(key))) return () => h.forbidden(`later-page write ${String(key)}`);
      if (key === 'then') return (resolve: (value: typeof reply) => unknown) => Promise.resolve(reply).then(resolve);
      return () => failed;
    } });
    return failed as ReturnType<InMemorySupabase['from']>;
  }) as typeof model.db.from;
  return () => reads;
}

beforeEach(() => {
  vi.clearAllMocks(); models = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
  fetchGuard = vi.fn(() => h.forbidden('global fetch')); vi.stubGlobal('fetch', fetchGuard);
});
afterEach(() => {
  expect(importBoundary).toEqual({ fetch: [], forbidden: [] }); expect(fetchGuard).not.toHaveBeenCalled(); expect(h.forbidden).not.toHaveBeenCalled();
  for (const model of models) expect(JSON.stringify(model.db.table('family_members'))).toBe(model.before);
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe('complete active-family roster preserves existing name precedence', () => {
  it('prefers a later exact Sam over earlier Samantha through cap1 in both real resolvers', async () => {
    const model = roster([member('prefix', 'Samantha', true, FAMILY, 1), member('exact', 'Sam', true, FAMILY, 2)], 1);
    expect(await both(model, '  sAM  ')).toMatchObject(selected('exact'));
  });

  it('prefers a later prefix over an earlier interior substring through cap1 in both resolvers', async () => {
    const model = roster([member('interior', 'Old Samantha', true, FAMILY, 1), member('prefix', 'Samantha', true, FAMILY, 2)], 1);
    expect(await both(model, 'saman')).toMatchObject(selected('prefix'));
  });

  it('preserves healthy uncapped matching and short-circuits blank names without a read', async () => {
    const model = roster([member('prefix', 'Samantha', true, FAMILY, 1), member('exact', 'Sam', true, FAMILY, 2)]);
    expect(await both(model, 'sam')).toMatchObject(selected('exact'));
    const reads = model.calls.length;
    expect(await both(model, '  ')).toEqual({ service: { ok: true, data: null }, assignee: { ok: true, data: null } });
    expect(await both(model, null)).toEqual({ service: { ok: true, data: null }, assignee: { ok: true, data: null } });
    expect(model.calls).toHaveLength(reads);
  });

  it('keeps inactive and foreign exact names outside the legitimate active-family prefix fallback', async () => {
    const model = roster([
      member('foreign', 'Sam', true, 'other-family', 1), member('inactive', 'Sam', false, FAMILY, 1),
      member('own-active', 'Samantha', true, FAMILY, 2),
    ], 1);
    expect(await both(model, 'sam')).toMatchObject(selected('own-active'));
  });

  it('keeps an unmatched name null at the service and an honest not-found refusal at the assignee boundary', async () => {
    const model = roster([member('one', 'Dana', true, FAMILY, 1), member('two', 'Lee', true, FAMILY, 2)], 1);
    const result = await both(model, 'Alex');
    expect(result.service).toEqual({ ok: true, data: null });
    expect(result.assignee).toMatchObject({ ok: false, code: 'not_found', error: 'There is nobody called Alex in this family.' });
  });

  it('refuses instead of choosing a partial prefix when a later page fails', async () => {
    const outcomes = [];
    for (const kind of ['service', 'assignee'] as const) {
      const model = roster([member('prefix', 'Samantha', true, FAMILY, 1), member('exact', 'Sam', true, FAMILY, 2)], 1);
      const reads = failSecondPage(model);
      const result = kind === 'service' ? await resolveMemberByName(model.scope, 'sam')
        : await resolveAssigneeId(model.scope, { assignee: 'sam' }, { requireActive: true });
      outcomes.push({ kind, reads: reads(), result });
    }
    expect(outcomes).toMatchObject([
      { kind: 'service', reads: 2, result: { ok: false, code: 'db' } },
      { kind: 'assignee', reads: 2, result: { ok: false, code: 'db' } },
    ]);
  });

  it('refuses the existing 2000-row completeness ceiling rather than selecting from a truncated roster', async () => {
    const rows = Array.from({ length: 2001 }, (_, i) => member(`member-${String(i).padStart(5, '0')}`, i === 0 ? 'Samantha' : i === 2000 ? 'Sam' : `Other ${i}`));
    const result = await both(roster(rows, 37), 'sam');
    expect(result.service).toMatchObject({ ok: false, code: 'db' });
    expect(result.assignee).toMatchObject({ ok: false, code: 'db' });
  });
});
