import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { HOUSEHOLD_DEFAULTS } from './helpers/household-fixtures';
import { byName, click, render } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

// H4 — the closet's "Wear" wrote the outfit log before the wear counts.
//
// outfits.item_ids is a uuid[] with no foreign key (0240), so deleting a
// wardrobe item left its id in every saved outfit. That id's compare-and-swap
// bump came back 'missing' on EVERY tap — after the outfit_logs row and every
// other item's +1 were already committed — so the screen said "That change
// wasn't saved", and each retry added another log row and another wear to the
// surviving items. Cost per wear, "most worn" and the history all inflated.
//
// Driven through the REAL ClosetModule (tests/helpers/module-harness.tsx)
// against an in-memory database.

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
vi.mock('@/components/app/page-header', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ai/ai-insight', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/media/family-media-img', async () => (await import('./helpers/module-harness')).ui);

const { ClosetModule } = await import('@/components/modules/closet-module');

const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
let db: ReturnType<typeof createInMemorySupabase>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-10T15:00:00Z'));
  resetHookSlots(h.hooks);
  db = createInMemorySupabase({ defaults: HOUSEHOLD_DEFAULTS });
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.toasts = { success: [], error: [] }; h.confirmAnswer = true; h.timeZone = 'UTC';
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db.seed('wardrobe_items', [
    { id: 'hoodie', name: 'Grey hoodie', category: 'top' },
    { id: 'jeans', name: 'Blue jeans', category: 'bottom' },
    { id: 'boots', name: 'Rain boots', category: 'shoes' },
  ]);
  db.seed('outfits', [{ id: 'rainy', name: 'Rainy school day', item_ids: ['hoodie', 'jeans', 'boots'] }]);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const screen = (): ReactNode => render(h.hooks, createElement(ClosetModule));
const wear = async () => { await click(byName(screen(), t('closet.wear'))); };
const count = (id: string) => db.table('wardrobe_items').find((row) => row.id === id)?.wear_count;

/** What deleteItem leaves behind: the row gone, its id still in the outfit. */
function deleteBoots() {
  db.replace('wardrobe_items', db.table('wardrobe_items').filter((row) => row.id !== 'boots'));
}

describe('a saved outfit with a deleted item is worn once per tap', () => {
  it('logs one wear of the items that still exist, and says so', async () => {
    deleteBoots();

    await wear();

    expect(h.toasts.error).toEqual([]);
    expect(h.toasts.success).toEqual([t('closetModule.loggedTodaySOutfit')]);
    expect(db.table('outfit_logs')).toHaveLength(1);
    expect(db.table('outfit_logs')[0].item_ids).toEqual(['hoodie', 'jeans']);
    expect([count('hoodie'), count('jeans')]).toEqual([1, 1]);
  });

  it('forgets the deleted item in the saved outfit, so the next tap is an ordinary wear', async () => {
    deleteBoots();

    await wear();
    await wear();

    expect(db.table('outfits')[0].item_ids).toEqual(['hoodie', 'jeans']);
    // Two taps, two wears — not two failures each leaving a log and a wear behind.
    expect(db.table('outfit_logs')).toHaveLength(2);
    expect([count('hoodie'), count('jeans')]).toEqual([2, 2]);
    expect(h.toasts.error).toEqual([]);
  });

  it('writes no log when a wear count could not be bumped', async () => {
    h.fault = (table, calls) => (table === 'wardrobe_items' && calls[0] === 'update' ? { message: 'Fixture write refused' } : null);

    await wear();

    expect(db.table('outfit_logs')).toEqual([]);
    expect(h.toasts.success).toEqual([]);
    expect(h.toasts.error).toHaveLength(1);
  });
});
