import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { getMessages, translate } from '@/lib/i18n/messages';

const mocks = vi.hoisted(() => ({
  context: vi.fn(), server: vi.fn(), revalidate: vi.fn(),
  setSlot: vi.fn(), removeSlot: vi.fn(),
  locale: 'en-US' as 'en-US' | 'de-DE',
  network: vi.fn(() => { throw new Error('Unexpected network call'); }),
}));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.context }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.server }));
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string) => translate(getMessages(mocks.locale), key),
}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }));
vi.mock('@/lib/services/meals', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/meals')>();
  mocks.setSlot.mockImplementation(actual.setSlot);
  mocks.removeSlot.mockImplementation(actual.removeSlot);
  return { ...actual, setSlot: mocks.setSlot, removeSlot: mocks.removeSlot };
});

import { planMealAction, removeMealPlanAction } from '@/app/(app)/dashboard/meals/actions';

type Row = Record<string, unknown>;
type RecordedRequest = { method: string; table: string; query: string; body: Row | Row[] | null };
const FAMILY = 'family-one', OTHER = 'family-two', DAY = '2026-09-28';
let tables: Record<string, Row[]>;
let requests: RecordedRequest[];
let failNextPlanRpc: boolean;
let nextPlanId: number;

function actor(role: 'parent' | 'adult' | 'teen' | 'child' | 'caregiver' | 'guest') {
  mocks.context.mockResolvedValue({
    user: { id: 'auth-actor' },
    active: {
      familyId: FAMILY, role, member: { id: 'member-actor', role, family_id: FAMILY },
      family: { id: FAMILY, timezone: 'UTC' },
    },
  });
}

// The real actions, services and SDK run; only identity/client construction and
// HTTP persistence are synthetic. This store enforces request filters, not SQL,
// RLS or triggers. A passing refusal proves the application boundary only.
async function transport(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init), url = new URL(request.url);
  if (url.origin !== 'https://meal-actions.invalid' || !url.pathname.startsWith('/rest/v1/')) {
    throw new Error('Unexpected synthetic transport destination');
  }
  const table = url.pathname.slice('/rest/v1/'.length), method = request.method;
  const raw = await request.text();
  const body: Row | Row[] | null = raw ? JSON.parse(raw) : null;
  requests.push({ method, table, query: url.search, body });
  if (table.startsWith('rpc/')) {
    const rpc = table.slice('rpc/'.length), args = body as Row;
    const rpcError = (code: string, message: string) => Response.json({ code, message, details: null, hint: null }, { status: 400 });
    if (rpc === 'meal_plan_replace_slots') {
      if (failNextPlanRpc) {
        failNextPlanRpc = false;
        return rpcError('40001', 'synthetic atomic write failure');
      }
      const entries = args.p_entries as Row[];
      const familyId = args.p_family_id;
      if (!Array.isArray(entries) || typeof familyId !== 'string') return rpcError('22023', 'invalid synthetic request');
      const planned = entries.map((entry) => {
        const meal = tables.meals.find((row) => row.id === entry.meal_id && row.family_id === familyId);
        return meal && {
          id: `plan-${++nextPlanId}`, family_id: familyId, meal_id: meal.id,
          plan_date: entry.plan_date, meal_type: entry.meal_type, created_by: 'auth-actor',
        };
      });
      if (planned.some((row) => !row)) return rpcError('42501', 'meal unavailable to family');
      const slots = new Set(entries.map((entry) => `${entry.plan_date}|${entry.meal_type}`));
      const old = tables.meal_plans.filter((row) => row.family_id === familyId && slots.has(`${row.plan_date}|${row.meal_type}`));
      tables.meal_plans = tables.meal_plans.filter((row) => !(row.family_id === familyId && slots.has(`${row.plan_date}|${row.meal_type}`)));
      tables.meal_plans.push(...planned as Row[]);
      return Response.json({ planned, replaced: old.length, replayed: false }, { status: 200 });
    }
    if (rpc === 'meal_plan_remove_slot') {
      const index = tables.meal_plans.findIndex((row) => row.id === args.p_plan_id && row.family_id === args.p_family_id);
      if (index < 0) return rpcError('P0002', 'planned meal not found');
      const [row] = tables.meal_plans.splice(index, 1);
      return Response.json({ id: args.p_plan_id, plan_date: row!.plan_date, meal_type: row!.meal_type, replayed: false }, { status: 200 });
    }
    if (rpc === 'meal_ensure_custom') {
      const familyId = args.p_family_id;
      const name = typeof args.p_name === 'string' ? args.p_name : '';
      if (typeof familyId !== 'string' || !name) return rpcError('22023', 'invalid synthetic custom meal');
      let meal = tables.meals.find((row) => row.family_id === familyId && row.name === name && row.meal_type === args.p_meal_type);
      const created = !meal;
      if (!meal) {
        meal = { id: `meal-${tables.meals.length + 1}`, family_id: familyId, name, meal_type: args.p_meal_type,
          ingredients: args.p_ingredients ?? [], recipe_url: args.p_recipe_url ?? null, image_url: args.p_image_url ?? null,
          created_by: 'auth-actor' };
        tables.meals.push(meal);
      }
      return Response.json({ meal, created }, { status: 200 });
    }
    return rpcError('42883', `Unexpected synthetic RPC: ${rpc}`);
  }
  if (!Object.hasOwn(tables, table)) throw new Error(`Unexpected table: ${table}`);
  const matches = (row: Row) => [...url.searchParams].every(([key, value]) => {
    if (['select', 'order', 'limit', 'offset'].includes(key)) return true;
    if (value.startsWith('eq.')) return String(row[key]) === value.slice(3);
    if (value.startsWith('in.(')) {
      return value.slice(4, -1).split(',').map((part) => part.replace(/^"|"$/g, '')).includes(String(row[key]));
    }
    throw new Error(`Unexpected predicate: ${value}`);
  });
  let rows: Row[];
  if (method === 'GET') rows = tables[table].filter(matches);
  else if (method === 'DELETE') {
    rows = tables[table].filter(matches);
    tables[table] = tables[table].filter((row) => !matches(row));
  } else if (method === 'POST' && body) {
    rows = (Array.isArray(body) ? body : [body]).map((row) => ({ ...row }));
    tables[table].push(...rows);
  } else throw new Error(`Unexpected method: ${method}`);
  const selected = method === 'GET' || request.headers.get('prefer')?.includes('return=representation');
  if (!selected) return new Response(null, { status: method === 'DELETE' ? 204 : 201 });
  const object = request.headers.get('accept')?.includes('application/vnd.pgrst.object+json');
  return Response.json(object ? (rows[0] ?? null) : rows, { status: method === 'POST' ? 201 : 200 });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.locale = 'en-US';
  requests = [];
  failNextPlanRpc = false;
  nextPlanId = 0;
  tables = {
    meals: [
      { id: 'rice', family_id: FAMILY, name: 'Rice', ingredients: [] },
      { id: 'soup', family_id: FAMILY, name: 'Soup', ingredients: [] },
      { id: 'private', family_id: OTHER, name: 'Private', ingredients: [] },
    ],
    family_recipes: [{ id: 'private-recipe', family_id: OTHER, name: 'Private', ingredients: [] }],
    meal_plans: [
      { id: 'prior', family_id: FAMILY, meal_id: 'rice', plan_date: DAY, meal_type: 'dinner', created_by: 'parent', idempotency_key: null },
      { id: 'foreign-plan', family_id: OTHER, meal_id: 'private', plan_date: DAY, meal_type: 'dinner', created_by: 'other' },
    ],
    audit_logs: [],
  };
  actor('parent');
  vi.stubGlobal('fetch', mocks.network);
  mocks.server.mockResolvedValue(createClient<Database>('https://meal-actions.invalid', 'synthetic-public-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: transport },
  }));
});
afterEach(() => {
  expect(mocks.network).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

const plan = () => planMealAction({ mealId: 'soup', date: DAY, mealType: 'dinner' });
const remove = () => removeMealPlanAction('prior');
function expectNoMealEffects(before: Record<string, Row[]>) {
  expect(mocks.setSlot).not.toHaveBeenCalled();
  expect(mocks.removeSlot).not.toHaveBeenCalled();
  expect(requests).toEqual([]);
  expect(tables).toEqual(before);
  expect(tables.audit_logs).toEqual([]);
  expect(mocks.revalidate).not.toHaveBeenCalled();
}

describe('a guest cannot change a saved meal placement', () => {
  it.each([['plan', plan], ['remove', remove]] as const)('refuses guest %s before any service or persistence effect', async (_name, action) => {
    actor('guest');
    const before = structuredClone(tables);
    expect(await action()).toEqual({ ok: false, error: getMessages('en-US')['actionRefusal.notAllowed'] });
    expectNoMealEffects(before);
  });

  it('uses the existing translated refusal', async () => {
    actor('guest');
    mocks.locale = 'de-DE';
    expect(await plan()).toEqual({ ok: false, error: getMessages('de-DE')['actionRefusal.notAllowed'] });
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it.each([['plan', plan], ['remove', remove]] as const)('preserves signed-out redirects for %s before a client or service is used', async (_name, action) => {
    mocks.context.mockRejectedValueOnce(new Error('NEXT_REDIRECT'));
    const before = structuredClone(tables);
    await expect(action()).rejects.toThrow('NEXT_REDIRECT');
    expect(mocks.server).not.toHaveBeenCalled();
    expectNoMealEffects(before);
  });

  // Non-guests retain the application's existing policy. These synthetic
  // controls deliberately make no assertion about what PostgreSQL permits.
  it.each(['parent', 'adult', 'teen', 'child', 'caregiver'] as const)('preserves %s replacement and removal behavior', async (role) => {
    actor(role);
    const saved = await plan();
    expect(saved).toMatchObject({ ok: true, slot: { mealId: 'soup', date: DAY } });
    if (!saved.ok) throw new Error('Expected a saved synthetic slot');
    expect(tables.meal_plans.filter((row) => row.family_id === FAMILY)).toHaveLength(1);
    expect(await removeMealPlanAction(saved.id)).toEqual({ ok: true, id: saved.id });
    expect(tables.meal_plans).toEqual([expect.objectContaining({ id: 'foreign-plan', meal_id: 'private' })]);
    expect(mocks.setSlot).toHaveBeenCalledOnce();
    expect(mocks.removeSlot).toHaveBeenCalledOnce();
    expect(mocks.revalidate.mock.calls).toEqual([['/dashboard/meals'], ['/dashboard/meals']]);
    expect(tables.audit_logs.length).toBeGreaterThan(0);
  });

  it.each([{ mealId: 'private' }, { recipeId: 'private-recipe' }])('retains the foreign-reference refusal for %j', async (reference) => {
    const before = structuredClone(tables);
    expect(await planMealAction({ ...reference, date: DAY, mealType: 'dinner' })).toMatchObject({ ok: false });
    expect(requests.filter((request) => request.method !== 'GET')).toEqual([]);
    expect(tables).toEqual(before);
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it('retains family filtering when removing a foreign slot', async () => {
    const before = structuredClone(tables);
    expect(await removeMealPlanAction('foreign-plan')).toMatchObject({ ok: false });
    expect(tables).toEqual(before);
    const removeRequest = requests.find((request) => request.table === 'rpc/meal_plan_remove_slot');
    expect(removeRequest?.body).toMatchObject({ p_family_id: FAMILY, p_plan_id: 'foreign-plan' });
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it('leaves the previous slot intact when the atomic plan RPC fails', async () => {
    failNextPlanRpc = true;
    expect(await plan()).toMatchObject({ ok: false });
    expect(tables.meal_plans.find((row) => row.id === 'prior')).toMatchObject({ meal_id: 'rice' });
    expect(tables.meal_plans.find((row) => row.id === 'foreign-plan')).toMatchObject({ meal_id: 'private' });
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });
});
