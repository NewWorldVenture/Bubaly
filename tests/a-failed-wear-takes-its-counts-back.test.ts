import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { takeBackWear, type WearStore } from '@/lib/closet/wear';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { HOUSEHOLD_DEFAULTS } from './helpers/household-fixtures';
import { byName, click, render } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

// HC2 — the closet's "Wear" bumps every item's wear count and then writes the
// outfit_logs row (H4 moved the log last). Nothing undid the bumps when the
// tap failed after them: a refused log row, or one bump failing beside others
// that landed, left those +1s committed under an error message, and the retry
// that message invites added them again. The repeatable trigger needs no
// fault: a saved outfit deleted on another phone stays on this screen (outfits
// is DELETE-blind), so its log fails the outfit_id foreign key on every tap —
// three taps, three wears on every item, no log.
//
// Driven through the REAL ClosetModule (tests/helpers/module-harness.tsx)
// against an in-memory database. The boundary is pinned at the end: when the
// take-back cannot be written, or a reply is lost, the client cannot make the
// tap all-or-nothing, and says so. That needs one transaction (an RPC that
// inserts the log and increments the counts together), recorded in
// lib/closet/wear.ts — not SQL written here.

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

const TODAY = '2026-10-10';
const ITEMS = ['hoodie', 'jeans', 'boots'];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(`${TODAY}T15:00:00Z`));
  resetHookSlots(h.hooks);
  db = createInMemorySupabase({ defaults: HOUSEHOLD_DEFAULTS });
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.toasts = { success: [], error: [] }; h.confirmAnswer = true; h.timeZone = 'UTC';
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db.seed('wardrobe_items', [
    { id: 'hoodie', name: 'Grey hoodie', category: 'top', wear_count: 4, last_worn_on: '2026-09-01' },
    { id: 'jeans', name: 'Blue jeans', category: 'bottom' },
    { id: 'boots', name: 'Rain boots', category: 'shoes' },
  ]);
  db.seed('outfits', [{ id: 'rainy', name: 'Rainy school day', item_ids: ITEMS }]);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const screen = (): ReactNode => render(h.hooks, createElement(ClosetModule));
const wear = async () => { await click(byName(screen(), t('closet.wear'))); };
const row = (id: string) => db.table('wardrobe_items').find((r) => r.id === id)!;
const counts = () => ITEMS.map((id) => row(id).wear_count);
const logs = () => db.table('outfit_logs');
const MAY_BE_COUNTED = () => t('closetModule.wearMayAlreadyBeCounted');

/** The calls the module makes, as the harness's `h.fault` sees them. */
const isBump = (table: string, calls: string[]) => table === 'wardrobe_items' && calls[0] === 'update';
const isLog = (table: string, calls: string[]) => table === 'outfit_logs' && calls[0] === 'insert';
/** A reply supabase-js builds when none came back: no database code. */
const LOST = { code: '', message: 'TypeError: fetch failed' };

describe('a failed wear takes back the counts it raised', () => {
  it('every bump lands, then the log is refused: the counts go back, and the retry counts once', async () => {
    let refusals = 1;
    h.fault = (table, calls) => (isLog(table, calls) && refusals-- > 0 ? { code: '57014', message: 'canceling statement due to statement timeout' } : null);

    await wear();

    expect(logs()).toEqual([]);
    expect(counts()).toEqual([4, 0, 0]);
    expect(row('hoodie').last_worn_on).toBe('2026-09-01');
    expect([row('jeans').last_worn_on, row('boots').last_worn_on]).toEqual([null, null]);
    expect(h.toasts.error).toHaveLength(1);
    expect(h.toasts.error).not.toContain(MAY_BE_COUNTED());
    expect(h.toasts.success).toEqual([]);

    await wear();

    expect(logs()).toHaveLength(1);
    expect(counts()).toEqual([5, 1, 1]);
    expect(ITEMS.map((id) => row(id).last_worn_on)).toEqual([TODAY, TODAY, TODAY]);
    expect(h.toasts.success).toEqual([t('closetModule.loggedTodaySOutfit')]);
  });

  it('one bump fails after another landed: the landed one goes back, and the retry counts once', async () => {
    let bumps = 0;
    // The second bump write fails; the first has already committed.
    h.fault = (table, calls) => (isBump(table, calls) && ++bumps === 2 ? { code: '40001', message: 'could not serialize access' } : null);

    await wear();

    expect(logs()).toEqual([]);
    expect(counts()).toEqual([4, 0, 0]);
    expect(row('hoodie').last_worn_on).toBe('2026-09-01');
    expect(h.toasts.error).toHaveLength(1);
    expect(h.toasts.error).not.toContain(MAY_BE_COUNTED());

    await wear();

    expect(logs()).toHaveLength(1);
    expect(counts()).toEqual([5, 1, 1]);
  });

  it('an item deleted between the presence check and its bump: the others go back, and the retry wears what is left', async () => {
    let bumps = 0;
    // Another phone's delete lands as the first bump is written: the boots
    // passed the presence check, and their own bump then finds no row.
    h.fault = (table, calls) => {
      if (isBump(table, calls) && ++bumps === 1) {
        db.replace('wardrobe_items', db.table('wardrobe_items').filter((r) => r.id !== 'boots'));
      }
      return null;
    };

    await wear();

    expect(logs()).toEqual([]);
    expect([row('hoodie').wear_count, row('jeans').wear_count]).toEqual([4, 0]);
    expect(h.toasts.error).toEqual([t('errors.thatChangeWasNotSaved')]);

    await wear();

    // The H4 repair still holds: the saved outfit forgets the deleted item.
    expect(db.table('outfits')[0].item_ids).toEqual(['hoodie', 'jeans']);
    expect(logs()).toHaveLength(1);
    expect(logs()[0].item_ids).toEqual(['hoodie', 'jeans']);
    expect([row('hoodie').wear_count, row('jeans').wear_count]).toEqual([5, 1]);
  });

  it('a saved outfit deleted on another phone fails every tap and inflates nothing', async () => {
    screen(); // the card is on this phone's screen
    db.replace('outfits', []); // deleted elsewhere; no DELETE event reaches this screen
    // outfit_logs.outfit_id REFERENCES outfits(id): Postgres refuses the insert.
    h.fault = (table, calls) => (isLog(table, calls) && !db.table('outfits').some((o) => o.id === 'rainy')
      ? { code: '23503', message: 'insert or update on table "outfit_logs" violates foreign key constraint "outfit_logs_outfit_id_fkey"' }
      : null);

    await wear();
    await wear();
    await wear();

    expect(logs()).toEqual([]);
    expect(counts()).toEqual([4, 0, 0]);
    expect(row('hoodie').last_worn_on).toBe('2026-09-01');
    expect(h.toasts.error).toHaveLength(3);
    expect(h.toasts.error).not.toContain(MAY_BE_COUNTED());
    expect(h.toasts.success).toEqual([]);
  });
});

describe('the boundary: what a client cannot make all-or-nothing', () => {
  it('when the take-back itself cannot be written, the counts stay raised and the closet says so', async () => {
    let bumps = 0;
    h.fault = (table, calls) => {
      if (isLog(table, calls)) return { code: '23503', message: 'insert or update on table "outfit_logs" violates foreign key constraint' };
      // The three bumps land; every write after them (the take-back) is refused.
      if (isBump(table, calls) && ++bumps > ITEMS.length) return { code: '42501', message: 'permission denied' };
      return null;
    };

    await wear();

    // Only a transaction spanning the bumps and the log closes this.
    expect(logs()).toEqual([]);
    expect(counts()).toEqual([5, 1, 1]);
    expect(h.toasts.error).toEqual([MAY_BE_COUNTED()]);
    expect(h.toasts.success).toEqual([]);
  });

  it('when the log\'s reply is lost, the wears are kept (the log may be there) and the closet says so', async () => {
    h.fault = (table, calls) => (isLog(table, calls) ? LOST : null);

    await wear();

    // Taking the wears back here would undercount a log that did commit.
    expect(counts()).toEqual([5, 1, 1]);
    expect(h.toasts.error).toEqual([MAY_BE_COUNTED()]);
    expect(h.toasts.success).toEqual([]);
  });

  it('when a bump\'s reply is lost, the landed ones go back but that one may have landed: the closet says so', async () => {
    let bumps = 0;
    h.fault = (table, calls) => (isBump(table, calls) && ++bumps === 2 ? LOST : null);

    await wear();

    expect(logs()).toEqual([]);
    expect(counts()).toEqual([4, 0, 0]);
    expect(h.toasts.error).toEqual([MAY_BE_COUNTED()]);
  });
});

describe('takeBackWear', () => {
  function store(row: { wear_count: number; last_worn_on: string | null }, opts: { interleave?: () => void } = {}) {
    let interleaved = false;
    const s: WearStore = {
      async readWearCount() { return { data: { ...row }, error: null }; },
      async writeWearCount(_id, expected, next, wornOn) {
        if (opts.interleave && !interleaved) { interleaved = true; opts.interleave(); }
        if (row.wear_count !== expected) return { data: [], error: null };
        row.wear_count = next; row.last_worn_on = wornOn;
        return { data: [{ id: 'item-1' }], error: null };
      },
    };
    return s;
  }

  it('puts the count and the date back when this wear is still the latest', async () => {
    const row = { wear_count: 5, last_worn_on: TODAY };
    expect(await takeBackWear(store(row), { id: 'item-1', count: 5, lastWornBefore: '2026-09-01' })).toBe(true);
    expect(row).toEqual({ wear_count: 4, last_worn_on: '2026-09-01' });
  });

  it('keeps another member\'s wear, and its date, that landed after this one', async () => {
    // Another member wore it today after our bump (5 → 6) and before our take-back.
    const row = { wear_count: 6, last_worn_on: TODAY };
    expect(await takeBackWear(store(row), { id: 'item-1', count: 5, lastWornBefore: '2026-09-01' })).toBe(true);
    expect(row).toEqual({ wear_count: 5, last_worn_on: TODAY });
  });

  it('re-reads when another writer moves the count under it, and still takes back exactly one', async () => {
    const row = { wear_count: 5, last_worn_on: TODAY };
    const s = store(row, { interleave: () => { row.wear_count += 1; } });
    expect(await takeBackWear(s, { id: 'item-1', count: 5, lastWornBefore: '2026-09-01' })).toBe(true);
    expect(row).toEqual({ wear_count: 5, last_worn_on: TODAY });
  });
});
