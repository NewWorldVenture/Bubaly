import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceScope } from '@/lib/services/types';

// Whole literal stored-card service boundary. Foreign references are valid-shaped IDs in another
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
vi.mock('@/lib/supabase/read-all-pages', () => ({ readAllPages: () => { fake.forbidden.push('unexpected paginated read'); throw Error('Unexpected memory-confirm dependency'); } }));
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
  recordFetch: () => { fake.defaultFetchCalls++; throw Error('Forbidden memory-confirm network'); },
};
const guard = process.env.BUBALY_ADAPTER_PHASE
  ? (globalThis as unknown as Record<symbol, Guard>)[Symbol.for('bubaly.memory.confirm.guard.v1')]
  : defaultGuard;
if (!guard || typeof guard.snapshot !== 'function' || typeof guard.recordFetch !== 'function') throw Error('Required memory-confirm guard is absent');
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
const CARD_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const FACT_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const DEADLINE = '2027-01-01T12:00:00.123456+00:00';
type Row = Record<string, unknown>;
type Call = { table: string; kind: 'select' | 'insert' | 'update' | 'delete'; filters: Row; payload?: Row };
let calls: Call[];
let card: Row | null;
let readError: unknown;
let historicalFact: Row | null;
let historicalError: unknown;
let insertMode: 'ok' | 'error' | 'empty';
let casMode: 'ok' | 'error' | 'empty';
let undoMode: 'ok' | 'error' | 'empty';
function pending(extra: Row = {}): Row {
  return { id: CARD_ID, family_id: 'family-a', member_id: MEMBER_A, category: 'preference',
    label: 'Go-to dinner', value: 'Pasta PRIVATE-VALUE', evidence: 'Synthetic conversation',
    signature: 'ai_memory:synthetic', status: 'suggested', fact_id: null, confidence: 70, expires_at: DEADLINE, ...extra };
}
function database(): ServiceScope['db'] {
  return { from: (table: string) => {
    if (!['family_facts', 'family_playbook_suggestions'].includes(table)) { fake.forbidden.push('unexpected table: ' + table); throw Error('Unexpected table'); }
    const call: Call = { table, kind: 'select', filters: {} }; calls.push(call);
    const reply = () => {
      if (call.kind === 'select' && table === 'family_playbook_suggestions') {
        const matches = card && call.filters.family_id === card.family_id && call.filters.id === card.id;
        return { data: matches ? card : null, error: readError };
      }
      if (call.kind === 'select') return { data: historicalFact, error: historicalError };
      if (call.kind === 'insert') return insertMode === 'error'
        ? { data: null, error: { message: 'Synthetic insert refusal' } }
        : { data: insertMode === 'empty' ? null : { id: FACT_ID, ...call.payload }, error: null };
      if (call.kind === 'update') return { data: casMode === 'empty' ? [] : [{ id: CARD_ID }], error: casMode === 'error' ? { message: 'Synthetic CAS refusal' } : null };
      return { data: undoMode === 'empty' ? [] : [{ id: FACT_ID }], error: undoMode === 'error' ? { message: 'Synthetic cleanup refusal' } : null };
    };
    const builder = {
      select: (_columns?: string) => builder,
      eq: (key: string, value: unknown) => { call.filters[key] = value; return builder; },
      insert: (payload: Row) => { call.kind = 'insert'; call.payload = payload; return builder; },
      update: (payload: Row) => { call.kind = 'update'; call.payload = payload; return builder; },
      delete: () => { call.kind = 'delete'; return builder; },
      maybeSingle: async () => reply(), single: async () => reply(),
      then: <T>(resolve: (value: ReturnType<typeof reply>) => T) => Promise.resolve(reply()).then(resolve),
    };
    return builder;
  } } as unknown as ServiceScope['db'];
}
function scope(extra: Partial<ServiceScope> = {}): ServiceScope {
  return { db: database(), familyId: 'family-a', userId: 'user-a', memberId: MEMBER_A,
    role: 'parent', actorKind: 'member', tz: 'UTC', now: new Date('2026-10-28T00:00:00Z'), ...extra };
}
async function confirm(extra: Partial<ServiceScope> = {}) { const { confirmFact } = await import('@/lib/services/memory'); return confirmFact(scope(extra), CARD_ID); }
const writes = () => calls.filter(call => call.kind !== 'select');
function noNewFactWork() { expect(writes()).toEqual([]); expect(fake.activity).toEqual([]); }
function scopedCardRead() { expect(calls[0]).toMatchObject({ table: 'family_playbook_suggestions', kind: 'select', filters: { family_id: 'family-a', id: CARD_ID } }); }

beforeEach(() => {
  calls = []; card = pending(); readError = null; historicalFact = null; historicalError = null;
  insertMode = 'ok'; casMode = 'ok'; undoMode = 'ok';
  fake.members = []; fake.activity = []; fake.settingsCalls = 0; fake.lookup = 'healthy'; fake.inactive = false;
  vi.stubGlobal('fetch', () => { fake.fetchCalls++; return guard.recordFetch(); });
  boundary();
});
afterEach(() => { boundary(); expect(fake.settingsCalls).toBe(0); vi.unstubAllGlobals(); });
afterAll(() => { expect(importSnapshot).toEqual({ forbiddenImports: [], fetchCalls: 0 }); boundary(); });

describe('memory confirmation admits a stored member reference before creating a new fact', () => {
  it('copies healthy provenance, exact deadline and confidence, then accepts the scoped card and records only its label', async () => {
    const result = await confirm();
    expect(result.ok).toBe(true); scopedCardRead();
    expect(writes().map(call => call.kind)).toEqual(['insert', 'update']);
    expect(writes()[0].payload).toMatchObject({ family_id: 'family-a', member_id: MEMBER_A, category: 'preference', label: 'Go-to dinner', value: 'Pasta PRIVATE-VALUE', notes: 'Learned by Bubaly — Synthetic conversation', source: 'ai_conversation', confidence: 70, expires_at: DEADLINE, created_by: 'user-a' });
    expect(writes()[1]).toMatchObject({ table: 'family_playbook_suggestions', payload: { status: 'accepted', fact_id: FACT_ID }, filters: { family_id: 'family-a', id: CARD_ID, status: 'suggested' } });
    expect(fake.activity).toHaveLength(1);
    expect(JSON.stringify(fake.activity)).not.toContain('PRIVATE-VALUE');
  });
  it('keeps a family-level card admissible without a member lookup', async () => {
    card = pending({ member_id: null });
    expect((await confirm()).ok).toBe(true);
    expect(writes()[0].payload?.member_id).toBeNull(); expect(fake.members).toEqual([]);
  });
  it('keeps a historical inactive same-family member admissible', async () => {
    fake.inactive = true;
    expect((await confirm()).ok).toBe(true); expect(writes()[0].payload?.member_id).toBe(MEMBER_A);
  });
  it('accepts a PostgreSQL UUID case alias without changing the stored reference wire value', async () => {
    card = pending({ member_id: MEMBER_A.toUpperCase() });
    expect((await confirm()).ok).toBe(true); expect(writes()[0].payload?.member_id).toBe(MEMBER_A.toUpperCase());
  });
  it('keeps a playbook miner card classified as an inference', async () => {
    card = pending({ signature: 'playbook:synthetic' });
    expect((await confirm()).ok).toBe(true); expect(writes()[0].payload?.source).toBe('ai_inferred');
  });
  it('keeps the marker without inventing evidence when the card has none', async () => {
    card = pending({ evidence: null });
    expect((await confirm()).ok).toBe(true); expect(writes()[0].payload?.notes).toBe('Learned by Bubaly');
  });
  it('refuses a known foreign-family reference in an otherwise ordinary pending card before INSERT, CAS or activity', async () => {
    card = pending({ member_id: MEMBER_B });
    expect((await confirm()).ok).toBe(false); scopedCardRead(); noNewFactWork();
    expect(fake.members).toEqual([{ familyId: 'family-a', memberId: MEMBER_B }]);
  });
  it.each(['missing', 'error', 'throw', 'mismatch'] as const)('defensively refuses the %s member receipt before creating a fact', async lookup => {
    fake.lookup = lookup;
    expect((await confirm()).ok).toBe(false); scopedCardRead(); noNewFactWork();
  });
  it.each(['child', 'teen', 'caregiver', 'guest'] as const)('preserves the %s refusal before any card or member read', async role => {
    expect((await confirm({ role })).ok).toBe(false); expect(calls).toEqual([]); expect(fake.members).toEqual([]); noNewFactWork();
  });
  it('still lets an adult confirm the household card', async () => { expect((await confirm({ role: 'adult' })).ok).toBe(true); });
  it('preserves the existing internal-system manager rule', async () => { expect((await confirm({ role: 'system', actorKind: 'system' })).ok).toBe(true); });
  it.each(['null data', 'partial data'] as const)('refuses a card read error with %s before member admission or writes', async kind => {
    if (kind === 'null data') card = null;
    readError = { message: 'Synthetic card read refusal' };
    expect((await confirm()).ok).toBe(false); expect(fake.members).toEqual([]); noNewFactWork();
  });
  it('preserves confirmed absence of the pending card without writes', async () => {
    card = null; expect((await confirm()).ok).toBe(false); expect(fake.members).toEqual([]); noNewFactWork();
  });
  it('reads the card only in the active family', async () => {
    card = pending({ family_id: 'family-b' });
    expect((await confirm()).ok).toBe(false); scopedCardRead(); expect(fake.members).toEqual([]); noNewFactWork();
  });
  it.each(['dismissed', 'unexpected-status'])('preserves refusal of a %s card before member admission', async status => {
    card = pending({ status }); expect((await confirm()).ok).toBe(false); expect(fake.members).toEqual([]); noNewFactWork();
  });
  it.each([['invalid', 'not-a-date'], ['expired', '2020-01-01T00:00:00Z']])('preserves the %s deadline refusal before member admission', async (_label, expires_at) => {
    card = pending({ expires_at }); expect((await confirm()).ok).toBe(false); expect(fake.members).toEqual([]); noNewFactWork();
  });
  it.each(['no fact id', 'existing fact', 'missing fact'] as const)('keeps accepted history with %s idempotent even when its old member reference is foreign', async history => {
    card = pending({ status: 'accepted', member_id: MEMBER_B, fact_id: history === 'no fact id' ? null : FACT_ID });
    if (history === 'existing fact') historicalFact = { id: FACT_ID, family_id: 'family-a', member_id: MEMBER_B };
    fake.lookup = 'error';
    const result = await confirm();
    expect(result).toMatchObject({ ok: true, data: { alreadyAccepted: true, fact: historicalFact } });
    expect(fake.members).toEqual([]); noNewFactWork();
    if (history !== 'no fact id') expect(calls[1].filters).toEqual({ family_id: 'family-a', id: FACT_ID });
  });
  it('preserves an accepted fact read refusal without member lookup or new writes', async () => {
    card = pending({ status: 'accepted', fact_id: FACT_ID }); historicalError = { message: 'Synthetic history read refusal' };
    expect((await confirm()).ok).toBe(false); expect(fake.members).toEqual([]); noNewFactWork();
  });
  it.each(['error', 'empty'] as const)('preserves a literal %s insert refusal without CAS, cleanup or activity', async mode => {
    insertMode = mode;
    expect((await confirm()).ok).toBe(false);
    expect(writes().map(call => call.kind)).toEqual(['insert']); expect(fake.activity).toEqual([]);
  });
  it.each(['error', 'empty'] as const)('preserves a literal %s CAS refusal and the exact family-scoped cleanup query', async mode => {
    casMode = mode;
    expect((await confirm()).ok).toBe(false);
    expect(writes().map(call => call.kind)).toEqual(['insert', 'update', 'delete']);
    expect(writes()[2].filters).toEqual({ family_id: 'family-a', id: FACT_ID }); expect(fake.activity).toEqual([]);
  });
  it.each(['error', 'empty'] as const)('keeps an unconfirmed %s cleanup receipt a refusal, not a success or another write attempt', async mode => {
    casMode = 'empty'; undoMode = mode;
    expect((await confirm()).ok).toBe(false);
    expect(writes().map(call => call.kind)).toEqual(['insert', 'update', 'delete']); expect(fake.activity).toEqual([]);
    // These are only literal query receipts. No actual commit/rollback,
    // transport failure, compensation safety or retry guarantee is claimed.
  });
});
