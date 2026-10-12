import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { HOUSEHOLD_DEFAULTS } from './helpers/household-fixtures';
import { byName, click, has, render } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

// H11 — an AI remix saved a new family_recipes row (/api/recipes/transform)
// and the list never showed it: the table is not realtime-published and
// remix() closed the modal without reading back. A cook who could not find
// the variant remixed again — a second paid call and a duplicate row.
//
// H12 — "Made it today" wrote `times_made = snapshot + 1`, the snapshot being
// the recipe as the modal opened. A second tap wrote the same number again,
// and a member whose page loaded before someone else's cook overwrote it.

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
vi.mock('@/components/ui/badge', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/app/page-header', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ai/ai-insight', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/app/(app)/dashboard/grocery/actions', () => ({ addGroceryItemsAction: vi.fn() }));

const { RecipesModule } = await import('@/components/modules/recipes-module');

const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
let db: ReturnType<typeof createInMemorySupabase>;
const transform = vi.fn();

beforeEach(() => {
  resetHookSlots(h.hooks);
  db = createInMemorySupabase({ defaults: HOUSEHOLD_DEFAULTS });
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.toasts = { success: [], error: [] }; h.confirmAnswer = true; h.timeZone = 'UTC';
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db.seed('family_recipes', [{ id: 'mac', name: 'Mac & Cheese', times_made: 0 }]);
  // The transform route, as far as this screen can see it: a new row, and
  // `{ ok, id }`.
  transform.mockReset().mockImplementation(async () => {
    db.seed('family_recipes', [{ id: 'mac-lite', name: 'Lighter Mac', ai_generated: true, source_provider: 'bubaly_ai', source_recipe_id: 'mac' }]);
    return Response.json({ ok: true, id: 'mac-lite' });
  });
  vi.stubGlobal('fetch', transform);
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const screen = (): ReactNode => render(h.hooks, createElement(RecipesModule));
const open = async () => { await click(byName(screen(), /^Mac & Cheese/)); };
const timesMade = () => db.table('family_recipes').find((row) => row.id === 'mac')?.times_made;

describe('an AI variant is on the list once it is saved (H11)', () => {
  it('shows the new variant without a reload', async () => {
    await open();
    await click(byName(screen(), t('recipesModule.aiAction.healthier')));

    expect(transform).toHaveBeenCalledTimes(1);
    expect(h.toasts.success).toContain(t('recipesModule.aiVariantSavedToYour'));
    expect(has(screen(), 'Lighter Mac')).toBe(true);
  });
});

describe('"Made it today" counts every cook (H12)', () => {
  it('two taps in one open recipe are two cooks', async () => {
    await open();
    await click(byName(screen(), t('recipes.madeItToday')));
    await click(byName(screen(), t('recipes.madeItToday')));

    expect(timesMade()).toBe(2);
    expect(h.toasts.success).toEqual([t('recipesModule.markedAsMadeToday'), t('recipesModule.markedAsMadeToday')]);
  });

  it('a cook another member logged after this page loaded is not overwritten', async () => {
    await open();
    // Someone else marks it on their phone; family_recipes is not published,
    // so this screen still holds the recipe at 0.
    db.table('family_recipes').find((row) => row.id === 'mac')!.times_made = 1;

    await click(byName(screen(), t('recipes.madeItToday')));

    expect(timesMade()).toBe(2);
  });

  it('a recipe that is gone says the change was not saved', async () => {
    await open();
    db.replace('family_recipes', []);

    await click(byName(screen(), t('recipes.madeItToday')));

    expect(h.toasts.error).toContain(t('errors.thatChangeWasNotSaved'));
    expect(h.toasts.success).toEqual([]);
  });
});
