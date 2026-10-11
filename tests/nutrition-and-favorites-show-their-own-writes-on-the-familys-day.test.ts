import { createElement, type ComponentType, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { HOUSEHOLD_DEFAULTS } from './helpers/household-fixtures';
import { allByName, byName, change, click, form, has, nodes, render, submit, type Node } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

// H7 — the Nutrition tracker saved and totalled food under GREENWICH's day:
// `todayKey()` was `toISOString().slice(0, 10)`. From 17:00 in a Pacific
// evening "today" was tomorrow — breakfast and lunch fell out of today's
// totals, and dinner was stored under the next day.
//
// H8 — nutrition_logs and family_favorites are not in the realtime
// publication, so no channel ever told these screens about a write, their own
// included. "Logged" and "Favorite added" were toasted over lists that did not
// change; a delete left the row on screen. People re-entered what they could
// not see, and neither table has a unique key.
//
// The REAL views, driven through tests/helpers/module-harness.tsx; the family
// clock is the real useFamilyClock, fed the family's zone.

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/lib/hooks/use-realtime-query', async () => (await import('./helpers/module-harness')).realtimeQueryModule(h));
vi.mock('@/lib/supabase/client', async () => (await import('./helpers/module-harness')).supabaseClientModule(h));
vi.mock('@/components/app/app-context', async () => (await import('./helpers/module-harness')).appContextModule(h));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/ui/confirm', async () => (await import('./helpers/module-harness')).confirmModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/modal', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/input', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/states', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/avatar', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/app/page-header', async () => (await import('./helpers/module-harness')).ui);

const { NutritionView } = await import('@/components/meals/nutrition-view');
const { FavoritesView } = await import('@/components/meals/favorites-view');

const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
let db: ReturnType<typeof createInMemorySupabase>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  // Saturday 10 October, 18:30 in Los Angeles — already the 11th in UTC.
  vi.setSystemTime(new Date('2026-10-11T01:30:00Z'));
  resetHookSlots(h.hooks);
  db = createInMemorySupabase({ defaults: HOUSEHOLD_DEFAULTS });
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.toasts = { success: [], error: [] }; h.confirmAnswer = true;
  h.timeZone = 'America/Los_Angeles';
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('confirm', () => true);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const screen = (Component: ComponentType): ReactNode => render(h.hooks, createElement(Component));
const inputs = (tree: ReactNode) => nodes(form(tree)).filter((node) => node.type === 'input');
/** The four total tiles, as one string. */
const tiles = (tree: ReactNode) => nodes(tree).filter((node) => typeof node.props.className === 'string' && node.props.className.includes('tabular-nums'))
  .map((node) => String(node.props.children)).join(' | ');

describe('the nutrition tracker keeps the family\'s day (H7)', () => {
  it('today is the 10th at 18:30 in Los Angeles: today\'s breakfast is listed and totalled', () => {
    db.seed('nutrition_logs', [{ id: 'log-1', logged_on: '2026-10-10', meal: 'breakfast', item: 'Oatmeal', calories: 300 }]);

    const tree = screen(NutritionView);

    expect(has(tree, 'Oatmeal')).toBe(true);
    expect(has(tree, t('nutrition.nothingLoggedToday'))).toBe(false);
    expect(tiles(tree)).toContain('300');
  });

  it('a new entry is dated the family\'s today, not tomorrow', async () => {
    await click(byName(screen(NutritionView), t('nutrition.logFood')));
    const date = inputs(screen(NutritionView)).find((node) => node.props.type === 'date') as Node;

    expect(date.props.value).toBe('2026-10-10');
  });
});

describe('the nutrition tracker shows its own writes (H8)', () => {
  it('a logged entry is on the list and in the totals as soon as it is saved', async () => {
    await click(byName(screen(NutritionView), t('nutrition.logFood')));
    // Controlled fields: each change is made on the field as last rendered.
    change(inputs(screen(NutritionView))[0], 'Chicken soup');
    change(inputs(screen(NutritionView)).find((node) => node.props.type === 'number')!, '420');

    await submit(form(screen(NutritionView)));
    const tree = screen(NutritionView);

    expect(db.table('nutrition_logs')).toEqual([expect.objectContaining({ item: 'Chicken soup', calories: 420, logged_on: '2026-10-10' })]);
    expect(h.toasts.success).toContain(t('nutritionView.logged'));
    expect(has(tree, 'Chicken soup')).toBe(true);
    expect(tiles(tree)).toContain('420');
  });

  it('a removed entry leaves the list', async () => {
    db.seed('nutrition_logs', [{ id: 'log-1', logged_on: '2026-10-10', meal: 'lunch', item: 'Sandwich', calories: 500 }]);
    expect(has(screen(NutritionView), 'Sandwich')).toBe(true);

    await click(byName(screen(NutritionView), t('nutritionView.delete')));
    const tree = screen(NutritionView);

    expect(db.table('nutrition_logs')).toEqual([]);
    expect(has(tree, 'Sandwich')).toBe(false);
    expect(allByName(tree, t('nutritionView.delete'))).toHaveLength(0);
  });
});

describe('family favorites show their own writes (H8)', () => {
  it('an added favorite is in the grid as soon as it is saved', async () => {
    await click(byName(screen(FavoritesView), t('favorites.addFavorite')));
    change(inputs(screen(FavoritesView))[0], 'Grandma’s lasagna');

    await submit(form(screen(FavoritesView)));
    const tree = screen(FavoritesView);

    expect(db.table('family_favorites')).toEqual([expect.objectContaining({ name: 'Grandma’s lasagna' })]);
    expect(h.toasts.success).toContain(t('favoritesView.favoriteAdded'));
    expect(has(tree, 'Grandma’s lasagna')).toBe(true);
    expect(has(tree, t('favorites.noFavoritesYet'))).toBe(false);
  });

  it('a removed favorite leaves the grid', async () => {
    db.seed('family_favorites', [{ id: 'fav-1', name: 'Taco Tuesday', kind: 'meal' }]);
    expect(has(screen(FavoritesView), 'Taco Tuesday')).toBe(true);

    await click(byName(screen(FavoritesView), t('favoritesView.remove')));
    const tree = screen(FavoritesView);

    expect(db.table('family_favorites')).toEqual([]);
    expect(has(tree, 'Taco Tuesday')).toBe(false);
  });
});
