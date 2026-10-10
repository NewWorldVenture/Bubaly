import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createClient } from '@supabase/supabase-js';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@/lib/database.types';
import { getMessages, translate } from '@/lib/i18n/messages';

type Row = Record<string, unknown>;
type Result = { data: Row[] | null; error: { message: string } | null };
type Query = { table: string; deps: unknown[]; fetcher: (db: ReturnType<typeof createClient<Database>>) => PromiseLike<Result> };
const seams = vi.hoisted(() => ({ tab: 'plan', stale: false, pending: new Set<string>(), queries: new Map<string, Query>(), results: new Map<string, Result>(), actions: vi.fn() }));
vi.mock('react', async original => {
  const actual = await original<typeof import('react')>();
  return { ...actual, useState: ((initial: unknown) => actual.useState(initial === 'plan' ? seams.tab : initial)) as typeof actual.useState };
});
vi.mock('@/components/app/app-context', () => ({ useApp: () => ({ familyId: 'family', userId: 'user', family: { timezone: 'UTC', name: 'Synthetic family' }, members: [], selfMember: null }) }));
vi.mock('@/components/i18n/locale-provider', () => ({ useLocale: () => ({ code: 'en-US' }), useFamilyTimeZone: () => 'UTC', useTranslations: () => (key: string, params?: Record<string, string | number>) => translate(getMessages('en-US'), key, params) }));
vi.mock('@/components/i18n/use-format', () => ({ useFormat: () => ({ fmtDate: (value: string) => value }) }));
vi.mock('@/lib/hooks/use-realtime-query', () => ({ useRealtimeQuery: (query: Query) => {
  seams.queries.set(query.table, query);
  const result = seams.results.get(query.table);
  return { data: result?.data ?? [], error: result?.error?.message ?? null, loading: !result || seams.pending.has(query.table), stale: seams.stale, refresh: vi.fn(), refreshAndConfirm: vi.fn() };
} }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => { throw Error('Only captured SDK transport is permitted'); } }));
vi.mock('@/app/(app)/dashboard/meals/actions', () => ({ createMealAction: seams.actions, planMealAction: seams.actions, removeMealPlanAction: seams.actions }));
vi.mock('@/app/(app)/dashboard/grocery/actions', () => ({ addMealPlanToGroceryListAction: seams.actions, setGroceryItemCheckedAction: seams.actions }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: seams.actions, error: seams.actions }) }));
vi.mock('next/link', () => ({ default: ({ children, ...props }: React.ComponentProps<'a'>) => React.createElement('a', props, children) }));
vi.mock('@/components/ui/modal', () => ({ Modal: () => null }));
vi.mock('@/components/ai/ai-insight', () => ({ AiInsight: () => null }));
import { MealsModule } from '@/components/modules/meals-module';
import { readMealWeek } from '@/lib/meals/collection-reads';

const dish = (id: string): Row => ({ id, family_id: 'family', name: `Synthetic dish ${id}`, meal_type: 'dinner', ingredients: [], image_url: null, recipe_url: null });
const recipe = (id: string, favorite = false): Row => ({ id, family_id: 'family', name: `Synthetic recipe ${id}`, category: 'dinner', difficulty: 'easy', ingredients: [], is_favorite: favorite, last_made_at: null, photo_url: null, prep_time_mins: null, cook_time_mins: null });
const grocery = (id: string): Row => ({ id, family_id: 'family', name: `Synthetic grocery ${id}`, list_id: 'list', quantity: null, category: null, is_checked: false, created_at: '2026-10-01T00:00:00Z' });
const slot = (id: string, date: string, mealId: string | null): Row => ({ id, family_id: 'family', meal_id: mealId, plan_date: date, meal_type: 'dinner' });
const render = () => renderToStaticMarkup(React.createElement(MealsModule));

// Actual component fetchers and SDK HTTP serialization; synthetic deterministic
// PostgREST subset, not hosted SQL/RLS or a substitute for hook lifecycle tests.
function sdk(tables: Record<string, Row[]>, fault = '', target = 'family_recipes', cap = 2) {
  const requests: URL[] = [];
  const db = createClient<Database>('https://synthetic-meal-collections.invalid', 'synthetic-not-secret', {
    accessToken: async () => null,
    global: { fetch: async (input, init) => {
      const u = new URL(String(input));
      const table = u.pathname.split('/').pop()!;
      expect(u.origin).toBe('https://synthetic-meal-collections.invalid');
      expect(init?.method ?? 'GET').toBe('GET');
      expect(new Headers(init?.headers).get('prefer')).toContain('count=exact');
      expect(u.searchParams.get('family_id')).toBe('eq.family');
      expect(Object.keys(tables)).toContain(table);
      requests.push(u);
      let rows = tables[table].filter(row => [...u.searchParams].every(([key, value]) => {
        if (['select', 'order', 'offset', 'limit'].includes(key)) return true;
        if (value.startsWith('eq.')) return String(row[key]) === value.slice(3);
        if (value.startsWith('gte.')) return String(row[key]) >= value.slice(4);
        if (value.startsWith('lte.')) return String(row[key]) <= value.slice(4);
        if (value.startsWith('in.(')) return value.slice(4, -1).split(',').map(v => v.replace(/^"|"$/g, '')).includes(String(row[key]));
        throw Error(`Unknown predicate ${key}=${value}`);
      }));
      const order = (u.searchParams.get('order') ?? '').split(',').filter(Boolean);
      rows.sort((a, b) => {
        for (const field of order) {
          const [key, direction, nulls] = field.split('.');
          if (a[key] === b[key]) continue;
          if (a[key] == null || b[key] == null) return a[key] == null ? (nulls === 'nullsfirst' ? -1 : 1) : (nulls === 'nullsfirst' ? 1 : -1);
          const cmp = String(a[key]).localeCompare(String(b[key]));
          if (cmp) return direction === 'desc' ? -cmp : cmp;
        }
        return 0;
      });
      const offset = Number(u.searchParams.get('offset') ?? 0);
      let total = rows.length;
      let data: unknown = rows.slice(offset, offset + Math.min(Number(u.searchParams.get('limit') ?? cap), cap));
      const affected = table === target;
      if (affected && fault === 'drift' && offset) total++;
      if (affected && fault === 'overflow') total = 20_001;
      if (affected && fault === 'short' && offset) data = [];
      if (affected && fault === 'duplicate' && offset) data = [rows[0]];
      if (affected && fault === 'foreign') data = (data as Row[]).map(row => ({ ...row, family_id: 'other' }));
      if (affected && fault === 'malformed') data = (data as Row[]).map(row => ({ ...row, name: 7, meal_type: 'unknown', plan_date: '2026-02-30' }));
      if (affected && fault === 'object') data = { length: 0 };
      if (affected && fault === 'error') return new Response(JSON.stringify({ code: '42501', message: 'Synthetic read refused' }), { status: 403 });
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (!(affected && fault === 'count')) headers['content-range'] = `${offset}-${offset + (Array.isArray(data) ? data.length : 0) - 1}/${total}`;
      return new Response(JSON.stringify(data), { status: 200, headers });
    } },
  });
  return { db, requests };
}
async function load(table: string, client: ReturnType<typeof sdk>) {
  render();
  const query = seams.queries.get(table)!;
  const result = await query.fetcher(client.db);
  seams.results.set(table, result);
  return result;
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-08T12:00:00Z'));
  seams.tab = 'plan'; seams.stale = false; seams.pending.clear(); seams.queries.clear(); seams.results.clear(); seams.actions.mockClear();
  vi.stubGlobal('fetch', vi.fn(() => { throw Error('External network prohibited'); }));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); expect(seams.actions).not.toHaveBeenCalled(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('complete meal UI reads before display filters', () => {
  it('renders a late-page favorite instead of saying there are none', async () => {
    seams.tab = 'favorites';
    const client = sdk({ family_recipes: [recipe('01'), recipe('02'), recipe('03', true)] });
    await load('family_recipes', client);
    expect(render()).toContain('Synthetic recipe 03');
    expect(render()).not.toContain('No favorites yet');
    expect(client.requests.map(u => u.searchParams.get('offset') ?? '0')).toEqual(['0', '2']);
  });
  it('renders the oldest unchecked grocery beyond the initial page', async () => {
    seams.tab = 'groceries';
    await load('grocery_items', sdk({ grocery_items: [grocery('01'), grocery('02'), grocery('03')] }));
    expect(render()).toContain('Synthetic grocery 03');
  });
  it('reads the whole saved library', async () => {
    const result = await load('meals', sdk({ meals: [dish('01'), dish('02'), dish('03')] }));
    expect(result.error).toBeNull(); expect(result.data).toHaveLength(3);
  });
  it('renders every week slot and independently paged joined dish', async () => {
    const client = sdk({ meal_plans: [slot('p1', '2026-10-05', '01'), slot('p2', '2026-10-06', '02'), slot('p3', '2026-10-07', '03'), slot('outside', '2026-10-12', '04')], meals: [dish('01'), dish('02'), dish('03'), dish('04')] });
    const result = await load('meal_plans', client);
    expect(result.error).toBeNull(); expect(result.data).toHaveLength(3);
    expect(render()).toContain('Synthetic dish 03');
    expect(render()).not.toContain('Synthetic dish 04');
  });
  it('keeps favorites after the former 200-recipe cap', async () => {
    seams.tab = 'favorites';
    await load('family_recipes', sdk({ family_recipes: Array.from({ length: 201 }, (_, i) => recipe(String(i).padStart(3, '0'), i === 200)) }, '', '', 1000));
    expect(render()).toContain('Synthetic recipe 200');
  });
  it('keeps the full grocery tab after the former 80-item cap', async () => {
    seams.tab = 'groceries';
    await load('grocery_items', sdk({ grocery_items: Array.from({ length: 81 }, (_, i) => grocery(String(i).padStart(3, '0'))) }, '', '', 1000));
    expect(render()).toContain('Synthetic grocery 080');
  });
  it('retains source sorting and appends stable identity on every page', async () => {
    const client = sdk({ family_recipes: [recipe('03'), { ...recipe('01'), last_made_at: '2026-10-01T00:00:00Z' }, recipe('02')] });
    const result = await load('family_recipes', client);
    expect(result.data?.map(row => row.id)).toEqual(['01', '02', '03']);
    for (const request of client.requests) expect(request.searchParams.get('order')).toBe('last_made_at.desc.nullslast,name.asc,id.asc');
    expect(client.requests.at(-1)?.searchParams.get('offset')).toBe('2');
  });
  it('versions every query cache so old prefixes are not reused', () => {
    render();
    for (const query of seams.queries.values()) expect(query.deps).toContain('complete-v1');
  });
  it('accepts an intentionally unassigned meal slot without querying dishes', async () => {
    const client = sdk({ meal_plans: [slot('p1', '2026-10-05', null)] });
    const result = await load('meal_plans', client);
    expect(result.error).toBeNull(); expect(result.data?.[0].meal).toBeNull();
    expect(client.requests).toHaveLength(1);
  });
  it('refuses an unresolved joined meal instead of presenting an empty slot', async () => {
    const result = await load('meal_plans', sdk({ meal_plans: [slot('p1', '2026-10-05', 'gone')], meals: [] }));
    expect(result.data).toBeNull(); expect(result.error).toBeTruthy();
    expect(render()).toContain('We couldn’t load all meal choices. Please retry.');
  });
  it('refuses competing duplicate slots', async () => {
    const client = sdk({ meal_plans: [slot('p1', '2026-10-05', '01'), slot('p2', '2026-10-05', '02')], meals: [dish('01'), dish('02')] });
    const result = await load('meal_plans', client);
    expect(result.data).toBeNull(); expect(result.error).toBeTruthy();
    expect(client.requests).toHaveLength(1);
  });
  it('rejects malformed/nonconsecutive week bounds before any SDK request', async () => {
    const client = sdk({});
    const days = ['2026-10-05', '2026-10-06', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11', '2026-10-12'];
    expect((await readMealWeek(client.db, 'family', days)).error).toBeTruthy();
    expect((await readMealWeek(client.db, 'family', ['2026-02-30'])).error).toBeTruthy();
    expect(client.requests).toHaveLength(0);
  });
  it('accepts a library exactly at the safety budget without truncating the final choice', async () => {
    const rows = Array.from({ length: 20_000 }, (_, i) => dish(String(i).padStart(5, '0')));
    const client = sdk({ meals: rows }, '', '', 1000);
    const result = await load('meals', client);
    expect(result.error).toBeNull(); expect(result.data).toHaveLength(20_000);
    expect(result.data?.at(-1)?.id).toBe('19999'); expect(client.requests).toHaveLength(20);
  });
  it('accepts independently confirmed empty collections', async () => {
    for (const table of ['meals', 'family_recipes', 'grocery_items', 'meal_plans']) {
      const result = await load(table, sdk({ [table]: [] }));
      expect(result).toEqual({ data: [], error: null });
    }
  });
});

const collectionTables = () => ({ meals: [dish('01'), dish('02'), dish('03')], family_recipes: [recipe('01'), recipe('02'), recipe('03', true)], grocery_items: [grocery('01'), grocery('02'), grocery('03')], meal_plans: [slot('p1', '2026-10-05', '01'), slot('p2', '2026-10-06', '02'), slot('p3', '2026-10-07', '03')] });
for (const table of ['meals', 'family_recipes', 'grocery_items', 'meal_plans']) {
  describe(`${table} complete read refusal`, () => {
    for (const fault of ['count', 'drift', 'overflow', 'short', 'duplicate', 'foreign', 'malformed', 'object', 'error']) {
      it(`refuses ${fault} without exposing a prefix`, async () => {
        const result = await load(table, sdk(collectionTables(), fault, table));
        expect(result.data).toBeNull(); expect(result.error).toBeTruthy();
      });
    }
  });
}
for (const fault of ['count', 'drift', 'short', 'duplicate', 'foreign', 'malformed', 'object', 'error']) {
  it(`refuses independently incomplete joined dishes: ${fault}`, async () => {
    const result = await load('meal_plans', sdk(collectionTables(), fault, 'meals'));
    expect(result.data).toBeNull(); expect(result.error).toBeTruthy();
    expect(render()).toContain('We couldn’t load all meal choices. Please retry.');
  });
}
for (const [table, patch] of [
  ['meals', { meal_type: 'unknown' }],
  ['meals', { image_url: { invalid: true } }],
  ['family_recipes', { is_favorite: 'false' }],
  ['family_recipes', { prep_time_mins: 'five' }],
  ['family_recipes', { last_made_at: 'not-a-date' }],
  ['family_recipes', { category: null }],
  ['grocery_items', { list_id: null }],
  ['grocery_items', { is_checked: 'false' }],
  ['grocery_items', { created_at: 'not-a-date' }],
  ['meal_plans', { meal_id: '' }],
  ['meal_plans', { plan_date: '2026-10-12' }],
] as const) {
  it(`refuses relevant malformed ${table} metadata ${Object.keys(patch)[0]}`, async () => {
    const tables: Record<string, Row[]> = collectionTables();
    tables[table][0] = { ...tables[table][0], ...patch };
    const result = await load(table, sdk(tables));
    if (table === 'meal_plans' && 'plan_date' in patch) {
      // A genuine outside-window row is excluded by the actual query bounds.
      expect(result.error).toBeNull(); expect(result.data).toHaveLength(2);
    } else { expect(result.data).toBeNull(); expect(result.error).toBeTruthy(); }
  });
}
for (const tab of ['favorites', 'recipes', 'groceries', 'plan']) {
  it(`does not present pending ${tab} as a confirmed empty collection`, () => {
    seams.tab = tab;
    const output = render();
    expect(output).not.toContain('No favorites yet');
    expect(output).not.toContain('No recipes yet');
    expect(output).not.toContain('Your list is empty');
    expect(output).not.toContain('No dinners planned this week yet');
  });
  it(`refuses stale cached ${tab} as current empty data`, () => {
    seams.tab = tab; seams.stale = true;
    for (const table of ['meals', 'family_recipes', 'grocery_items', 'meal_plans']) seams.results.set(table, { data: [], error: null });
    expect(render()).toContain('We couldn’t load all meal choices. Please retry.');
    expect(render()).not.toContain('No favorites yet');
    expect(render()).not.toContain('No recipes yet');
    expect(render()).not.toContain('Your list is empty');
    expect(render()).not.toContain('No dinners planned this week yet');
  });
}
for (const state of ['pending', 'error', 'stale']) {
  it(`Recently Cooked independently refuses ${state} cached recipe prefixes`, () => {
    seams.tab = 'plan'; seams.stale = state === 'stale';
    for (const table of ['meals', 'family_recipes', 'grocery_items', 'meal_plans']) seams.results.set(table, { data: [], error: null });
    seams.results.set('family_recipes', { data: [{ ...recipe('UNVERIFIED'), last_made_at: '2026-10-01T00:00:00Z' }], error: state === 'error' ? { message: 'Synthetic recipe read unavailable' } : null });
    if (state === 'pending') seams.pending.add('family_recipes');
    const output = render();
    expect(output).not.toContain('Synthetic recipe UNVERIFIED');
    if (state === 'pending') expect(output).toContain('aria-label="Loading"');
    else { expect(output).toContain('Try again'); expect(output).toContain(state === 'error' ? 'Synthetic recipe read unavailable' : 'We couldn’t load all meal choices. Please retry.'); }
  });
}
