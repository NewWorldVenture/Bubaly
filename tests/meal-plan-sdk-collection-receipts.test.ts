import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { planWeek, removeSlot, type MealPlanRow } from '@/lib/services/meals';
import type { ServiceScope } from '@/lib/services/types';

const seams = vi.hoisted(() => ({ activity: [] as unknown[] }));
vi.mock('@/lib/services/activity', () => ({ recordActivitySafely: async (_scope: unknown, event: unknown) => { seams.activity.push(event); } }));
vi.mock('@/lib/services/family', () => ({ getMembers: () => { throw Error('unexpected family read'); } }));
vi.mock('@/lib/services/idempotency', () => ({
  withIdempotency: () => { throw Error('unexpected idempotency wrapper'); },
  makeKey: (parts: unknown[]) => JSON.stringify(parts),
}));
vi.mock('@/lib/meals/pantry-chef', () => ({ normalizeAllergies: () => { throw Error('unexpected food-profile read'); } }));

const family = 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001';
const user = 'cccccccc-cccc-4ccc-8ccc-000000000003';
const meal = { id: 'existing-dish', family_id: family, name: 'Synthetic meal', meal_type: 'dinner', ingredients: [], created_by: user,
  recipe_url: null, image_url: null, notes: null, created_at: '2026-09-08T00:00:00Z', updated_at: '2026-09-08T00:00:00Z' };
const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'planned-slot', family_id: family, meal_id: meal.id, plan_date: '2026-09-08', meal_type: 'dinner', created_by: user,
  idempotency_key: null, created_at: '2026-09-08T00:00:00Z', updated_at: '2026-09-08T00:00:00Z', ...overrides,
});
type RecordedCall = { name: string; args: Record<string, unknown>; kind: string };
type Options = { replaceData?: unknown; replaceError?: unknown; removeData?: unknown; removeError?: unknown; readback?: unknown[] };
function createDb(options: Options = {}) {
  const calls: RecordedCall[] = [];
  const persisted = options.readback ?? [row()];
  const from = (table: string) => {
    const call = { name: table, args: {} as Record<string, unknown>, kind: 'select' };
    calls.push(call);
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    Object.assign(builder, {
      select: chain, order: chain, limit: chain,
      eq: (column: string, value: unknown) => { call.args[column] = value; return builder; },
      in: (column: string, value: unknown) => { call.args[column] = value; return builder; },
      insert: (_value: unknown) => { call.kind = 'insert'; return builder; },
      update: (_value: unknown) => { call.kind = 'update'; return builder; },
      delete: () => { call.kind = 'delete'; return builder; },
      maybeSingle: async () => ({ data: call.name === 'meals' ? meal : null, error: null }),
      single: async () => ({ data: null, error: null }),
      then: (resolve: (value: { data: unknown; error: unknown }) => unknown) =>
        Promise.resolve(resolve({ data: call.name === 'meal_plans' ? persisted : call.name === 'meals' ? [meal] : null, error: null })),
    });
    return builder;
  };
  const rpc = async (name: string, args: Record<string, unknown>) => {
    calls.push({ name: 'rpc:' + name, args, kind: 'rpc' });
    if (name === 'meal_plan_replace_slots' || name === 'meal_plan_replace_slots_for_actor') return { data: Object.hasOwn(options, 'replaceData') ? options.replaceData : { planned: [row()], replaced: 1, replayed: false }, error: options.replaceError ?? null };
    if (name === 'meal_plan_remove_slot' || name === 'meal_plan_remove_slot_for_actor') return { data: Object.hasOwn(options, 'removeData') ? options.removeData : {
      id: 'planned-slot', plan_date: '2026-09-08', meal_type: 'dinner', replayed: false,
    }, error: options.removeError ?? null };
    return { data: null, error: null };
  };
  return { db: { from, rpc } as unknown as SupabaseClient<Database>, calls };
}

function scope(db: SupabaseClient<Database>, extra: Partial<ServiceScope> = {}): ServiceScope {
  return { db, familyId: family, userId: user, memberId: null, role: 'parent', actorKind: 'member', tz: 'UTC', now: new Date('2026-09-08T12:00:00Z'), ...extra };
}
const entries = [{ date: '2026-09-08', mealType: 'dinner' as const, mealId: meal.id }];

beforeEach(() => { seams.activity.length = 0; });

const malformedReceipts: [string, unknown][] = [
  ['null', null], ['wrong-array', [row()]], ['false', false], ['true', true], ['zero', 0], ['one', 1],
  ['empty-string', ''], ['object-zero', { length: 0 }], ['object-one', { length: 1 }],
  ['object-no-length', {}], ['empty-array', []], ['null-entry', { planned: [null], replaced: 0, replayed: false }],
  ['scalar-entry', { planned: [7], replaced: 0, replayed: false }],
];

describe('meal-plan atomic RPC receipts', () => {
  it.each(malformedReceipts)('refuses malformed replacement receipt: %s without a compensating table write', async (_name, replaceData) => {
    const { db, calls } = createDb({ replaceData });
    const result = await planWeek(scope(db), entries, 'receipt-control');
    expect(result).toMatchObject({ ok: false, code: 'db' });
    expect(calls.some((call) => call.name === 'rpc:meal_plan_replace_slots')).toBe(true);
    expect(calls.some((call) => call.name === 'meal_plans' && ['insert', 'delete'].includes(call.kind))).toBe(false);
  });

  const badRows: [string, unknown][] = [
    ['foreign-family', row({ family_id: 'foreign' })], ['wrong-actor', row({ created_by: 'someone-else' })],
    ['wrong-meal', row({ meal_id: 'other-meal' })], ['wrong-date', row({ plan_date: '2026-09-09' })],
    ['wrong-type', row({ meal_type: 'snack' })], ['empty-ID', row({ id: '' })],
    ['missing-meal', row({ meal_id: null })],
  ];
  it.each(badRows)('refuses mismatched committed row receipt: %s and never rolls back by guess', async (_name, savedRow) => {
    const { db, calls } = createDb({ replaceData: { planned: [savedRow], replaced: 1, replayed: false }, readback: [savedRow] });
    const result = await planWeek(scope(db), entries, 'mismatch-control');
    expect(result).toMatchObject({ ok: false, code: 'db' });
    expect(calls.some((call) => call.name === 'meal_plans' && ['insert', 'delete'].includes(call.kind))).toBe(false);
    expect(seams.activity).toEqual([]);
  });

  it.each([
    ['non-integer replaced', 0.5, false], ['negative replaced', -1, false],
    ['no replay state', 1, undefined],
  ])('rejects inconsistent transactional counters %s', async (_label, replaced, replayed) => {
    const { db } = createDb({ replaceData: { planned: [row()], replaced, replayed } });
    expect(await planWeek(scope(db), entries, 'counter-control')).toMatchObject({ ok: false, code: 'db' });
  });

  it('returns a confirmed row for a healthy transaction and keeps unrelated family rows out of the request', async () => {
    const { db, calls } = createDb();
    const result = await planWeek(scope(db), entries, 'healthy');
    expect(result).toMatchObject({ ok: true, data: { replaced: 1, planned: [{ id: 'planned-slot', date: entries[0].date, mealType: 'dinner', mealId: meal.id }] } });
    expect(calls.find((call) => call.name === 'rpc:meal_plan_replace_slots')?.args).toEqual({
      p_family_id: family, p_request_id: 'healthy', p_entries: [{ meal_id: meal.id, plan_date: entries[0].date, meal_type: 'dinner' }],
    });
    expect(seams.activity).toHaveLength(1);
  });

  it('uses only the executor ledger client and scoped actor for delegated replacement', async () => {
    const userClient = createDb();
    const ledgerClient = createDb();
    const delegatedScope = scope(userClient.db, { toolOperation: { id: 'executor-only-operation', db: ledgerClient.db } });
    const untrustedEntry = { ...entries[0], actorId: 'attacker-selected-actor' } as typeof entries[number];
    const result = await planWeek(delegatedScope, [untrustedEntry], 'delegated-replace-request');
    expect(result.ok).toBe(true);
    expect(userClient.calls.some((call) => call.name.startsWith('rpc:'))).toBe(false);
    expect(ledgerClient.calls.find((call) => call.name === 'rpc:meal_plan_replace_slots_for_actor')?.args).toEqual({
      p_family_id: family, p_actor_id: user, p_request_id: 'delegated-replace-request',
      p_entries: [{ meal_id: meal.id, plan_date: entries[0].date, meal_type: entries[0].mealType }],
    });
    expect(ledgerClient.calls.some((call) => call.name === 'rpc:meal_plan_replace_slots')).toBe(false);
  });

  it('uses only the executor ledger client and scoped actor for delegated removal', async () => {
    const userClient = createDb();
    const ledgerClient = createDb();
    const delegatedScope = scope(userClient.db, { toolOperation: { id: 'executor-only-operation', db: ledgerClient.db } });
    expect(await removeSlot(delegatedScope, 'planned-slot', 'delegated-remove-request')).toEqual({ ok: true, data: { id: 'planned-slot' } });
    expect(userClient.calls.some((call) => call.name.startsWith('rpc:'))).toBe(false);
    expect(ledgerClient.calls.find((call) => call.name === 'rpc:meal_plan_remove_slot_for_actor')?.args).toEqual({
      p_family_id: family, p_actor_id: user, p_request_id: 'delegated-remove-request', p_plan_id: 'planned-slot',
    });
    expect(ledgerClient.calls.some((call) => call.name === 'rpc:meal_plan_remove_slot')).toBe(false);
  });

  it('refuses delegated writes without a scoped actor before any read, write, or RPC', async () => {
    const userClient = createDb();
    const ledgerClient = createDb();
    const delegatedScope = scope(userClient.db, { userId: null, toolOperation: { id: 'executor-only-operation', db: ledgerClient.db } });
    expect(await planWeek(delegatedScope, [{ date: '2026-09-08', mealName: 'Synthetic custom dish' }]))
      .toMatchObject({ ok: false, code: 'denied' });
    expect(await removeSlot(delegatedScope, 'planned-slot', 'missing-actor-remove'))
      .toMatchObject({ ok: false, code: 'denied' });
    expect(userClient.calls).toEqual([]);
    expect(ledgerClient.calls).toEqual([]);
    expect(seams.activity).toEqual([]);
  });

  it('treats a lost RPC response as unknown and never tries client-side compensation', async () => {
    const { db, calls } = createDb({ replaceError: new Error('connection reset after commit') });
    expect(await planWeek(scope(db), entries, 'lost-response')).toMatchObject({ ok: false, error: expect.stringContaining('confirm') });
    expect(calls.filter((call) => call.name === 'meal_plans' && ['insert', 'delete'].includes(call.kind))).toEqual([]);
  });

  it('does not report a remove success from a wrong-ID or malformed receipt', async () => {
    const incompleteReceipts = [
      ['null', { id: 'planned-slot', meal_type: 'dinner', replayed: false }],
      ['null day', { id: 'planned-slot', plan_date: null, meal_type: 'dinner', replayed: false }],
      ['numeric day', { id: 'planned-slot', plan_date: 20260908, meal_type: 'dinner', replayed: false }],
      ['impossible day', { id: 'planned-slot', plan_date: '2026-02-30', meal_type: 'dinner', replayed: false }],
      ['missing type', { id: 'planned-slot', plan_date: '2026-09-08', replayed: false }],
      ['null type', { id: 'planned-slot', plan_date: '2026-09-08', meal_type: null, replayed: false }],
      ['numeric type', { id: 'planned-slot', plan_date: '2026-09-08', meal_type: 3, replayed: false }],
      ['unknown type', { id: 'planned-slot', plan_date: '2026-09-08', meal_type: 'brunch', replayed: false }],
    ] as const;
    for (const [label, removeData] of incompleteReceipts) {
      const { db, calls } = createDb({ removeData });
      expect(await removeSlot(scope(db), 'planned-slot', 'remove-key'), label).toMatchObject({ ok: false, code: 'db' });
      expect(calls.some((call) => call.name === 'rpc:meal_plan_remove_slot')).toBe(true);
    }
    for (const removeData of [null, 'id', [], { id: 'different-slot', replayed: false }, { id: 'planned-slot' }]) {
      const { db, calls } = createDb({ removeData });
      expect(await removeSlot(scope(db), 'planned-slot', 'remove-key')).toMatchObject({ ok: false, code: 'db' });
      expect(calls.some((call) => call.name === 'rpc:meal_plan_remove_slot')).toBe(true);
    }
    expect(seams.activity).toEqual([]);
  });

  it('binds removal receipts to the exact plan ID and records the operation once', async () => {
    const { db, calls } = createDb({ removeData: { id: 'planned-slot', plan_date: '2026-09-08', meal_type: 'dinner', replayed: false } });
    expect(await removeSlot(scope(db), 'planned-slot', 'remove-key')).toEqual({ ok: true, data: { id: 'planned-slot' } });
    expect(calls.find((call) => call.name === 'rpc:meal_plan_remove_slot')?.args).toEqual({
      p_family_id: family, p_request_id: 'remove-key', p_plan_id: 'planned-slot',
    });
    expect(seams.activity).toHaveLength(1);
  });

  it('accepts a complete replay receipt without recording the delete twice', async () => {
    const { db, calls } = createDb({ removeData: {
      id: 'planned-slot', plan_date: '2026-09-08', meal_type: 'dinner', replayed: true,
    } });
    expect(await removeSlot(scope(db), 'planned-slot', 'remove-key')).toEqual({ ok: true, data: { id: 'planned-slot' } });
    expect(calls.find((call) => call.name === 'rpc:meal_plan_remove_slot')?.args).toEqual({
      p_family_id: family, p_request_id: 'remove-key', p_plan_id: 'planned-slot',
    });
    expect(seams.activity).toEqual([]);
  });
});
