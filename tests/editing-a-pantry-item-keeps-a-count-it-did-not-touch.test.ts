// Editing a pantry item does not put back the count it opened with.
//
// The pantry editor fills its quantity (and unit) from the row as it was when
// the modal opened, and sent both on every save — and savePantryItem wrote them
// as absolutes. A parent fixing Milk's best-by date while a partner tapped +1,
// or while a put-away landed a gallon from another phone, saved the old count
// over theirs: the lost update pantryAdjust's compare-and-set exists to stop.
// The form now sends the count and unit only when it changed them, and the
// service keeps what the row holds when they are not sent.
//
// The real PantryModule, its real server action and the real service, driven
// against an in-memory database (tests/helpers/module-harness.tsx).
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { HOUSEHOLD_DEFAULTS } from './helpers/household-fixtures';
import { byName, click, form, render, submit } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

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
vi.mock('@/components/ui/card', async () => {
  const { createElement: el } = await import('react');
  return { Card: ({ children }: { children?: ReactNode }) => el('section', null, children) };
});
// The server action runs for real, as the signed-in parent, on the same database.
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({ user: { id: h.app.userId }, active: {
    familyId: h.app.familyId, role: 'parent', member: { id: 'member-1' }, family: { timezone: 'UTC', name: 'Fixture family' },
  } }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/app/(app)/dashboard/grocery/actions', () => ({ addGroceryItemsAction: vi.fn() }));

const { PantryModule } = await import('@/components/modules/pantry-module');

const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
let db: ReturnType<typeof createInMemorySupabase>;
const milk = () => db.table('pantry_items').find((row) => row.id === 'milk')!;

beforeEach(() => {
  resetHookSlots(h.hooks);
  db = createInMemorySupabase({ defaults: HOUSEHOLD_DEFAULTS });
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.toasts = { success: [], error: [] }; h.confirmAnswer = true; h.timeZone = 'UTC';
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db.seed('pantry_items', [{
    id: 'milk', family_id: h.app.familyId, name: 'Milk', quantity: 2, unit: 'gal', location: 'fridge',
    category: 'Dairy & Eggs', expires_at: '2026-10-20', low_threshold: null, is_staple: false, notes: null,
  }]);
});
afterEach(() => vi.restoreAllMocks());

const screen = (): ReactNode => render(h.hooks, createElement(PantryModule));
async function openEditor() {
  await click(byName(screen(), t('pantry.edit')));
}

describe('the pantry editor', () => {
  it('saving a new best-by date keeps a +1 another member made while the form was open', async () => {
    await openEditor();
    // Someone else's +1 (or a put-away) lands while the editor is open.
    milk().quantity = 3;

    await submit(form(screen()), { expires_at: '2026-10-25' });

    expect(h.toasts.error).toEqual([]);
    expect(milk()).toMatchObject({ quantity: 3, unit: 'gal', expires_at: '2026-10-25' });
  });

  it('a count the family did change is saved as typed', async () => {
    await openEditor();
    milk().quantity = 3;

    await submit(form(screen()), { quantity: '5' });

    expect(milk()).toMatchObject({ quantity: 5, unit: 'gal' });
  });

  it('a new item still starts at the count the form says', async () => {
    await click(byName(screen(), new RegExp(t('pantry.addItem'))));

    await submit(form(screen()), { name: 'Eggs', quantity: '12', unit: '' });

    expect(db.table('pantry_items').find((row) => row.name === 'Eggs')).toMatchObject({ quantity: 12, unit: null });
  });
});
