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
type RecordedRequest = { method: string; table: string; query: string; body?: Row | Row[] | null };
const FAMILY = 'family-one', OTHER = 'family-two', DAY = '2026-09-28';
let tables: Record<string, Row[]>;
let requests: RecordedRequest[];
let malformedReplaceReceipt: boolean;
let activeMembership = { role: 'parent', is_active: true };
let nextSyntheticPlan = 0;

function actor(role: 'parent' | 'adult' | 'teen' | 'child' | 'caregiver' | 'guest') {
  activeMembership = { role, is_active: true };
  if (tables?.family_members) {
    tables.family_members = [{ id: 'member-actor', family_id: FAMILY, user_id: 'auth-actor', ...activeMembership }];
  }
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
  if (table.startsWith('rpc/')) {
    const name = table.slice('rpc/'.length);
    requests.push({ method, table: `rpc:${name}`, query: url.search, body });
    if (method !== 'POST' || !body || Array.isArray(body)) throw new Error(`Unexpected RPC request: ${name}`);
    if (activeMembership.is_active !== true || activeMembership.role === 'guest'
      || !tables.family_members.some((member) => member.family_id === body.p_family_id
        && member.user_id === 'auth-actor' && member.is_active === true && member.role !== 'guest')) {
      return Response.json({ message: 'Not an active non-guest member' }, { status: 400 });
    }
    if (body.p_family_id !== FAMILY) return Response.json({ message: 'Not an active family member' }, { status: 400 });
    if (name === 'meal_plan_replace_slots') {
      if (malformedReplaceReceipt) {
        malformedReplaceReceipt = false;
        return Response.json({}, { status: 200 });
      }
      if (!Array.isArray(body.p_entries) || body.p_entries.length === 0) return Response.json({ message: 'Invalid entries' }, { status: 400 });
      const entries = body.p_entries as Row[];
      if (entries.some((entry) => !entry || typeof entry.meal_id !== 'string'
        || !tables.meals.some((meal) => meal.id === entry.meal_id && meal.family_id === FAMILY)
        || typeof entry.plan_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.plan_date)
        || !['breakfast', 'lunch', 'dinner', 'snack'].includes(String(entry.meal_type)))) {
        return Response.json({ message: 'Invalid or foreign meal-plan entry' }, { status: 400 });
      }
      const slots = new Set(entries.map((entry) => `${entry.plan_date}:${entry.meal_type}`));
      const removed = tables.meal_plans.filter((row) => row.family_id === FAMILY && slots.has(`${row.plan_date}:${row.meal_type}`));
      tables.meal_plans = tables.meal_plans.filter((row) => !removed.includes(row));
      const planned = entries.map((entry) => ({
        id: `synthetic-plan-${++nextSyntheticPlan}`, family_id: FAMILY, meal_id: entry.meal_id,
        plan_date: entry.plan_date, meal_type: entry.meal_type, created_by: 'auth-actor',
      }));
      tables.meal_plans.push(...planned);
      return Response.json({ planned, replaced: removed.length, replayed: false });
    }
    if (name === 'meal_plan_remove_slot') {
      const index = tables.meal_plans.findIndex((row) => row.id === body.p_plan_id && row.family_id === FAMILY);
      if (index < 0) return Response.json({ message: 'Planned meal not found' }, { status: 400 });
      const [removed] = tables.meal_plans.splice(index, 1);
      return Response.json({ id: removed.id, plan_date: removed.plan_date, meal_type: removed.meal_type, replayed: false });
    }
    throw new Error(`Unexpected RPC: ${name}`);
  }
  if (!Object.hasOwn(tables, table)) throw new Error(`Unexpected table: ${table}`);
  requests.push({ method, table, query: url.search, body });
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
  malformedReplaceReceipt = false;
  nextSyntheticPlan = 0;
  activeMembership = { role: 'parent', is_active: true };
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
    family_members: [],
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
    expect(requests.find((request) => request.table === 'rpc:meal_plan_remove_slot')?.body)
      .toMatchObject({ p_family_id: FAMILY, p_plan_id: 'foreign-plan' });
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it('does not claim success or issue table compensation after an unknown atomic receipt', async () => {
    malformedReplaceReceipt = true;
    expect(await plan()).toMatchObject({ ok: false });
    expect(tables.meal_plans.find((row) => row.id === 'prior')).toMatchObject({ meal_id: 'rice' });
    expect(tables.meal_plans.find((row) => row.id === 'foreign-plan')).toMatchObject({ meal_id: 'private' });
    expect(requests.some((request) => request.table === 'rpc:meal_plan_replace_slots')).toBe(true);
    expect(requests.filter((request) => request.table === 'meal_plans' && request.method !== 'GET')).toEqual([]);
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });
});
