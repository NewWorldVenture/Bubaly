import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceScope } from '@/lib/services/types';

// Whole literal service boundary. Foreign references are real IDs in another
// synthetic family; error/throw/mismatch receipts are separate defensive cases.
const fake = vi.hoisted(() => ({
  forbidden: [] as string[], fetchCalls: 0, defaultFetchCalls: 0,
  lookup: 'healthy' as 'healthy' | 'missing' | 'error' | 'throw' | 'mismatch',
  inactive: false, settings: 'enabled' as 'enabled' | 'disabled' | 'error',
  members: [] as Array<{ familyId: string; memberId: string }>,
  activity: [] as unknown[], settingsCalls: 0,
}));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/services/family', () => ({
  getMember: async (scope: { familyId: string }, memberId: string) => {
    fake.members.push({ familyId: scope.familyId, memberId });
    if (fake.lookup === 'throw') throw { message: 'Synthetic member read refusal' };
    if (fake.lookup === 'error') return { ok: false, code: 'db', error: 'Synthetic member read unavailable' };
    if (fake.lookup === 'missing' || scope.familyId !== 'family-a' || memberId.toLowerCase() !== 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') {
      return { ok: false, code: 'not_found', error: 'That family member could not be found.' };
    }
    return { ok: true, data: { id: fake.lookup === 'mismatch' ? 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' : memberId.toLowerCase(), isActive: !fake.inactive } };
  },
}));
vi.mock('@/lib/services/activity', () => ({ recordActivitySafely: async (_scope: unknown, entry: unknown) => { fake.activity.push(entry); } }));
vi.mock('@/lib/services/ai-settings', () => ({ loadAISettings: async () => {
  fake.settingsCalls++;
  return fake.settings === 'error' ? { ok: false, error: 'Synthetic settings refusal' } : { ok: true, data: { memoryEnabled: fake.settings === 'enabled' } };
} }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/services/scope', () => ({ scopeNow: (scope: { now?: Date }) => scope.now ?? new Date('2026-10-28T00:00:00Z') }));
vi.mock('@/lib/supabase/errors', () => ({ describeDbError: () => 'Synthetic database refusal', wroteNoRows: (rows: unknown) => Array.isArray(rows) && rows.length === 0 }));
vi.mock('@/lib/supabase/read-all-pages', () => ({ readAllPages: () => { fake.forbidden.push('unexpected paginated read'); throw Error('Unexpected memory-create dependency'); } }));
vi.mock('@supabase/supabase-js', () => { fake.forbidden.push('SDK'); throw Error('Forbidden SDK implementation'); });
vi.mock('@supabase/ssr', () => { fake.forbidden.push('SSR'); throw Error('Forbidden SSR implementation'); });
vi.mock('@supabase/auth-js', () => { fake.forbidden.push('Auth SDK'); throw Error('Forbidden Auth implementation'); });
vi.mock('@/lib/supabase/server', () => { fake.forbidden.push('server'); throw Error('Forbidden server implementation'); });
vi.mock('@/lib/supabase/client', () => { fake.forbidden.push('client'); throw Error('Forbidden client implementation'); });
vi.mock('@/lib/supabase/auth', () => { fake.forbidden.push('Auth'); throw Error('Forbidden Auth implementation'); });
vi.mock('@/shared/auth/refresh-fetch', () => { fake.forbidden.push('refresh'); throw Error('Forbidden refresh implementation'); });
vi.mock('@/lib/auth/cache-session', () => { fake.forbidden.push('cache-session'); throw Error('Forbidden cache implementation'); });
vi.mock('@/lib/auth/browser-session-storage', () => { fake.forbidden.push('session-storage'); throw Error('Forbidden session implementation'); });
vi.mock('@/lib/ai/provider', () => { fake.forbidden.push('provider'); throw Error('Forbidden provider implementation'); });
vi.mock('@/lib/ai/provider-stub', () => { fake.forbidden.push('provider-stub'); throw Error('Forbidden provider implementation'); });
vi.mock('next/cache', () => { fake.forbidden.push('next/cache'); throw Error('Forbidden cache implementation'); });

type Guard = { snapshot(): { forbiddenImports: string[]; fetchCalls: number }; recordFetch(): never };
const defaultGuard: Guard = {
  snapshot: () => ({ forbiddenImports: [...fake.forbidden], fetchCalls: fake.defaultFetchCalls }),
  recordFetch: () => { fake.defaultFetchCalls++; throw Error('Forbidden memory-create network'); },
};
const guard = process.env.BUBALY_ADAPTER_PHASE
  ? (globalThis as unknown as Record<symbol, Guard>)[Symbol.for('bubaly.memory.create.guard.v1')]
  : defaultGuard;
if (!guard || typeof guard.snapshot !== 'function' || typeof guard.recordFetch !== 'function') throw Error('Required memory-create guard is absent');
const importSnapshot = guard.snapshot();
expect(importSnapshot).toEqual({ forbiddenImports: [], fetchCalls: 0 });
function boundary() {
  expect(fake.forbidden).toEqual([]);
  expect(fake.fetchCalls).toBe(0);
  expect(fake.defaultFetchCalls).toBe(0);
  expect(guard.snapshot()).toEqual({ forbiddenImports: [], fetchCalls: 0 });
}

const MEMBER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MEMBER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
type Call = { table: string; kind: string; filters: Record<string, unknown>; payload?: Record<string, unknown> };
let calls: Call[];
let existing: Record<string, unknown> | null;
function database(): ServiceScope['db'] {
  return { from: (table: string) => {
    if (!['family_facts', 'family_playbook_suggestions'].includes(table)) { fake.forbidden.push('unexpected table: ' + table); throw Error('Unexpected table'); }
    const call: Call = { table, kind: 'select', filters: {} };
    calls.push(call);
    const reply = () => ({ data: call.kind === 'select' ? existing : { id: table === 'family_facts' ? 'new-fact' : 'new-suggestion', ...call.payload }, error: null });
    const builder = {
      select: (_columns?: string) => builder,
      eq: (key: string, value: unknown) => { call.filters[key] = value; return builder; },
      is: (key: string, value: unknown) => { call.filters[key] = value; return builder; },
      ilike: (key: string, value: unknown) => { call.filters['ilike:' + key] = value; return builder; },
      limit: (_limit: number) => builder,
      insert: (payload: Record<string, unknown>) => { call.kind = 'insert'; call.payload = payload; return builder; },
      update: (payload: Record<string, unknown>) => { call.kind = 'update'; call.payload = payload; return builder; },
      maybeSingle: async () => reply(), single: async () => reply(),
    };
    return builder;
  } } as unknown as ServiceScope['db'];
}
function scope(extra: Partial<ServiceScope> = {}): ServiceScope {
  return { db: database(), familyId: 'family-a', userId: 'user-a', memberId: MEMBER_A, role: 'parent', actorKind: 'member', tz: 'UTC', now: new Date('2026-10-28T00:00:00Z'), ...extra };
}
type Input = Parameters<(typeof import('@/lib/services/memory'))['rememberFact']>[1];
const input = (extra: Partial<Input> = {}): Input => ({ key: 'Dinner preference', content: 'Pasta', category: 'preference', source: 'user', memberId: MEMBER_A, ...extra });
async function remember(value = input(), extra: Partial<ServiceScope> = {}) { const { rememberFact } = await import('@/lib/services/memory'); return rememberFact(scope(extra), value); }
const writes = () => calls.filter(call => call.kind !== 'select');
function noMemoryWork() { expect(calls).toEqual([]); expect(fake.activity).toEqual([]); }

beforeEach(() => {
  calls = []; existing = null; fake.members = []; fake.activity = []; fake.settingsCalls = 0;
  fake.lookup = 'healthy'; fake.inactive = false; fake.settings = 'enabled';
  vi.stubGlobal('fetch', () => { fake.fetchCalls++; return guard.recordFetch(); });
  boundary();
});
afterEach(() => { boundary(); vi.unstubAllGlobals(); });
afterAll(() => { expect(importSnapshot).toEqual({ forbiddenImports: [], fetchCalls: 0 }); boundary(); });

describe('memory creation admits member references only inside its active family', () => {
  it('creates a confirmed fact for a saved same-family member', async () => {
    const result = await remember();
    expect(result.ok).toBe(true);
    expect(writes()).toHaveLength(1);
    expect(writes()[0].payload).toMatchObject({ family_id: 'family-a', member_id: MEMBER_A, source: 'user', label: 'Dinner preference', value: 'Pasta' });
    expect(fake.activity).toHaveLength(1);
  });
  it('keeps inactive same-family historical members admissible', async () => {
    fake.inactive = true;
    expect((await remember()).ok).toBe(true);
    expect(writes()[0].payload?.member_id).toBe(MEMBER_A);
  });
  it('accepts a PostgreSQL UUID case alias for the same saved member', async () => {
    expect((await remember(input({ memberId: MEMBER_A.toUpperCase() }))).ok).toBe(true);
    expect(writes()[0].payload?.member_id).toBe(MEMBER_A.toUpperCase());
  });
  it('keeps AI inference unconfirmed in the inbox when memory is enabled', async () => {
    const result = await remember(input({ source: 'ai_inferred' }), { actorKind: 'ai' });
    expect(result.ok).toBe(true);
    expect(writes()).toHaveLength(1);
    expect(writes()[0].table).toBe('family_playbook_suggestions');
    expect(fake.activity).toEqual([]);
    expect(fake.settingsCalls).toBe(1);
  });
  it('keeps a human import confirmed rather than silently inferred', async () => {
    expect((await remember(input({ source: 'import' }))).ok).toBe(true);
    expect(writes()[0].table).toBe('family_facts');
  });
  it.each([['omitted', undefined], ['null', null]] as const)('keeps the %s member reference at family level without a member lookup', async (_label, memberId) => {
    expect((await remember(input({ memberId }))).ok).toBe(true);
    expect(writes()[0].payload?.member_id).toBeNull();
    expect(fake.members).toEqual([]);
  });
  it('preserves an empty member wire input without lookup; no real DB write admission is claimed', async () => {
    // This fake DB records wire shape only; PostgreSQL may reject an empty UUID.
    // Same-family admission must not silently normalize that existing input.
    expect((await remember(input({ memberId: '' }))).ok).toBe(true);
    expect(writes()[0].payload?.member_id).toBe('');
    expect(fake.members).toEqual([]);
  });
  it.each(['user', 'ai_inferred'] as const)('refuses a known foreign-family ID on the %s lane before any fact probe or write', async source => {
    // A form chosen under family B can still contain B's valid ID after the
    // authenticated active family changes to A. This is not an error+data model.
    const result = await remember(input({ source, memberId: MEMBER_B }), { actorKind: source === 'user' ? 'member' : 'ai' });
    expect(result.ok).toBe(false);
    noMemoryWork();
    expect(fake.members).toEqual([{ familyId: 'family-a', memberId: MEMBER_B }]);
  });
  it.each(['missing', 'error', 'throw', 'mismatch'] as const)('defensively refuses the %s member receipt without touching memory rows', async lookup => {
    fake.lookup = lookup;
    expect((await remember()).ok).toBe(false);
    noMemoryWork();
  });
  it.each([
    ['a teen writing medical information', { category: 'medical' }, { role: 'teen' }],
    ['an AI turn claiming direct medical input', { category: 'medical' }, { actorKind: 'ai' }],
    ['an inferred sensitive fact', { category: 'account', source: 'ai_inferred' }, { actorKind: 'ai' }],
  ] as const)('preserves refusal for %s before any memory probe', async (_label, value, actor) => {
    expect((await remember(input(value), actor)).ok).toBe(false);
    noMemoryWork();
  });
  it('still permits a teen to enter an ordinary memory about herself', async () => {
    expect((await remember(input(), { role: 'teen' })).ok).toBe(true);
    expect(writes()[0].payload?.member_id).toBe(MEMBER_A);
  });
  it.each(['disabled', 'error'] as const)('preserves the %s AI-memory setting refusal', async settings => {
    fake.settings = settings;
    expect((await remember(input({ source: 'ai_inferred' }), { actorKind: 'ai' })).ok).toBe(false);
    noMemoryWork();
  });
  it('does not apply the AI-memory switch to a person entering a fact', async () => {
    fake.settings = 'disabled';
    expect((await remember()).ok).toBe(true);
    expect(fake.settingsCalls).toBe(0);
  });
  it.each([
    ['blank label', { key: ' ' }], ['blank value', { content: ' ' }],
    ['oversized value', { content: 'x'.repeat(2001) }],
    ['unknown source', { source: 'unrecognized' as Input['source'] }],
    ['invalid expiry', { expiresAt: 'not-a-date' }],
  ])('preserves the %s input refusal', async (_label, value) => {
    expect((await remember(input(value as Partial<Input>))).ok).toBe(false);
    noMemoryWork();
  });
  it('keeps restating a same-family fact in place under the existing author rule', async () => {
    existing = { id: 'fact-existing', family_id: 'family-a', member_id: MEMBER_A, created_by: 'user-a', category: 'preference', label: 'Dinner preference', value: 'Old pasta' };
    expect((await remember()).ok).toBe(true);
    expect(writes()).toHaveLength(1);
    expect(writes()[0].kind).toBe('update');
    expect(writes()[0].filters).toMatchObject({ id: 'fact-existing', family_id: 'family-a' });
  });
});
