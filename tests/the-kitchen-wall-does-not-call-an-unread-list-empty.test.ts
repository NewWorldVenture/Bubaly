import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactElement, type ReactNode } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { DisplayData } from '@/components/display/display-grid';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { renderTranslated } from './helpers/render-translated';

// H19 — the Kitchen Display settled its meal-plan, grocery and chore reads and,
// on failure, only logged them. loadStatus tracked the calendar and reminders,
// not these, so a failed read reached the wall as "No meals planned",
// "0 items · List is empty" and "All done! 🎉" — for the whole 120-second
// refresh — beside calendar tiles that correctly said Unavailable, and the
// "Some display data is unavailable" banner never showed.

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/auth', () => ({ requireFeature: async () => ({ user: { id: 'user-1' }, active: { familyId: 'family-1', family: { name: 'Fixture family', timezone: 'UTC' } } }) }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => state.db }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key, getLocaleContext: async () => ({ locale: { code: 'en-US' }, source: 'default' }) }));
vi.mock('next/navigation', () => ({
  unstable_rethrow: () => {},
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => '/display', useSearchParams: () => new URLSearchParams(), redirect: () => {}, notFound: () => {},
}));
vi.mock('@/components/display/auto-refresh', () => ({ AutoRefresh: () => null }));
vi.mock('@/components/display/display-shell-client', () => ({ DisplayShellClient: () => null }));

import Page from '@/app/(app)/display/page';
import { DisplayShell, resolveDisplaySettings } from '@/components/display/display-grid';
import { DEFAULT_TILES } from '@/lib/display/tiles';
import { ToastProvider } from '@/components/ui/toast';

let failed: Set<string>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-12T15:00:00Z'));
  const db = createInMemorySupabase<SupabaseClient<Database>>();
  failed = new Set();
  // A read of a table in `failed` answers { data: null, error }, as supabase-js does.
  state.db = { from(table: string) {
    const target = db.from(table);
    const proxy: object = new Proxy(target, { get(object, property) {
      if (property === 'then') return (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
        failed.has(table) ? Promise.resolve({ data: null, count: null, error: { message: 'Fixture read failed' } }).then(resolve, reject) : object.then(resolve as never, reject);
      const value = Reflect.get(object, property);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => { const result = Reflect.apply(value, object, args); return result === object ? proxy : result; };
    } });
    return proxy;
  }, rpc: db.rpc.bind(db) };
  db.seed('meal_plans', [{ family_id: 'family-1', plan_date: '2026-09-12', meal_id: 'meal', meal_type: 'dinner' }]);
  db.seed('meals', [{ id: 'meal', family_id: 'family-1', name: 'Family dinner' }]);
  db.seed('grocery_items', [{ id: 'g1', family_id: 'family-1', name: 'Milk', is_checked: false }]);
  db.seed('chores', [{ id: 'chore', family_id: 'family-1', title: 'Dishes' }]);
  db.seed('chore_assignments', [{ id: 'a1', family_id: 'family-1', chore_id: 'chore', member_id: 'm1', status: 'todo', due_at: '2026-09-12T12:00:00Z' }]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

async function load(): Promise<DisplayData> {
  const node = await Page();
  const find = (input: ReactNode): DisplayData | undefined => {
    if (Array.isArray(input)) return input.map(find).find(Boolean);
    if (!input || typeof input !== 'object' || !('props' in input)) return undefined;
    const props = (input as ReactElement<{ data?: DisplayData; children?: ReactNode }>).props;
    return props.data ?? find(props.children);
  };
  const data = find(node);
  if (!data) throw new Error('the page rendered no display data');
  return data;
}

function wall(data: DisplayData): string {
  return renderTranslated(createElement(ToastProvider, null, createElement(DisplayShell, {
    initialTiles: DEFAULT_TILES, initialSettings: resolveDisplaySettings(null), data, familyId: 'family-1', userId: 'user-1',
  })));
}

describe('the page reports the meal, grocery and chore reads', () => {
  it('reads them all and says so', async () => {
    const data = await load();
    expect(data.loadStatus).toMatchObject({ meals: 'ok', grocery: 'ok', chores: 'ok' });
    expect(data.meals).toEqual([{ type: 'dinner', name: 'Family dinner' }]);
    expect(data.grocery.count).toBe(1);
  });

  it.each([
    ['meal_plans', 'meals'], ['meals', 'meals'], ['grocery_items', 'grocery'], ['chore_assignments', 'chores'],
  ])('a failed %s read marks %s unavailable', async (table, tile) => {
    failed.add(table);
    const data = await load();
    expect(data.loadStatus?.[tile as 'meals']).toBe('error');
  });
});

describe('the wall says "unavailable", not empty, for a read that failed', () => {
  it('meals, groceries and chores render as unavailable, with the banner', async () => {
    failed.add('meal_plans'); failed.add('grocery_items'); failed.add('chore_assignments');
    const html = wall(await load());

    // The markup escapes the apostrophe in "Today's".
    expect(html).toContain('s meals are unavailable.');
    expect(html).toContain('The grocery list is unavailable.');
    expect(html).toContain('Chores are unavailable.');
    expect(html).toContain('Some display data is unavailable. The display will retry automatically.');
    expect(html).not.toContain('No meals planned');
    expect(html).not.toContain('List is empty');
    expect(html).not.toContain('All done!');
  });

  it('a genuinely empty kitchen is still shown as empty', async () => {
    const data = await load();
    const html = wall({ ...data, meals: [], grocery: { items: [], count: 0 }, chores: [] });
    expect(html).toContain('No meals planned');
    expect(html).toContain('List is empty');
    expect(html).not.toContain('Some display data is unavailable.');
  });
});
