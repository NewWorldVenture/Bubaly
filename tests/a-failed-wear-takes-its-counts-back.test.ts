import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { bumpWearCount, takeBackWear, type LandedWear, type WearStore } from '@/lib/closet/wear';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { HOUSEHOLD_DEFAULTS } from './helpers/household-fixtures';
import { allByName, byName, click, render, settle, type Node } from './helpers/module-harness';
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
//
// HD2 — two failed taps on one item that overlap (two phones) are taken back
// by count alone, and a take-back owns the last-worn date only while the
// count says its wear is the latest. Taken back in the order they landed,
// they left a never-worn item at 0 wears "worn today", and an item worn
// before at its old count but today's date. The first is fixed (no wear left
// is no date); the second is what one date column with no history cannot
// tell, and is pinned below as the limit lib/closet/wear.ts states.

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());

/** While `on`, each outfit_logs insert waits in `held` until the test lets it through. */
const logGate = vi.hoisted(() => ({ on: false, held: [] as (() => void)[] }));

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/lib/hooks/use-realtime-query', async () => (await import('./helpers/module-harness')).realtimeQueryModule(h));
vi.mock('@/lib/supabase/client', async () => {
  const { clientFor } = await import('./helpers/module-harness');
  /** The harness builder, its answer held while the gate is on and it is a log insert. */
  function gated(builder: object, table: string): object {
    let inserts = false;
    const proxy: object = new Proxy(builder, {
      get(target, property) {
        if (property === 'then') {
          return (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => {
            const answer = () => (target as PromiseLike<unknown>).then(resolve, reject);
            if (!(logGate.on && table === 'outfit_logs' && inserts)) return answer();
            return new Promise<void>((release) => { logGate.held.push(release); }).then(answer);
          };
        }
        const value = Reflect.get(target, property);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          if (property === 'insert') inserts = true;
          const result = Reflect.apply(value, target, args);
          return result === target ? proxy : result;
        };
      },
    });
    return proxy;
  }
  return {
    createClient: () => {
      const client = clientFor(h);
      return { ...client, from: (table: string) => gated(client.from(table), table) };
    },
  };
});
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
  logGate.on = false; logGate.held = [];
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
const OLD = '2026-09-01';

/**
 * Two phones on the closet, each its own ClosetModule against the one
 * database. A tap is started, not awaited, so the other phone's can overlap it.
 */
const phones = (): ReactNode => render(h.hooks, createElement('div', null, [
  createElement(ClosetModule, { key: 'phone-a' }), createElement(ClosetModule, { key: 'phone-b' }),
]));
const tap = (button: Node) => Promise.resolve((button.props.onClick as (event: unknown) => unknown)({ preventDefault() {}, stopPropagation() {} }));
async function until(condition: () => boolean) {
  for (let turn = 0; turn < 100 && !condition(); turn++) await settle();
  expect(condition()).toBe(true);
}

/** The saved outfit is deleted on a third phone: both phones still show it, and its log fails the foreign key. */
function deletedElsewhere() {
  phones(); // the card is on both phones' screens
  db.replace('outfits', []); // no DELETE event reaches either
  h.fault = (table, calls) => (isLog(table, calls) && !db.table('outfits').some((o) => o.id === 'rainy')
    ? { code: '23503', message: 'insert or update on table "outfit_logs" violates foreign key constraint "outfit_logs_outfit_id_fkey"' }
    : null);
}

/**
 * Phone A's tap lands its wears, then phone B's lands on top of them, with
 * both logs held; then the logs answer, and each phone takes its wears back,
 * in the order given.
 */
async function overlappingTaps(takenBack: 'as they landed' | 'latest first') {
  const [wearA, wearB] = allByName(phones(), t('closet.wear'));
  logGate.on = true;
  const a = tap(wearA);
  await until(() => logGate.held.length === 1);
  expect(row('hoodie')).toMatchObject({ wear_count: 5, last_worn_on: TODAY });
  const b = tap(wearB);
  await until(() => logGate.held.length === 2);
  expect(counts()).toEqual([6, 2, 2]);
  const [answerA, answerB] = logGate.held;
  if (takenBack === 'as they landed') { answerA(); await a; answerB(); await b; } else { answerB(); await b; answerA(); await a; }
  await settle();
}

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

describe('two failed taps that overlap on one item (HD2)', () => {
  it('taken back latest first: every count and every date is as it was', async () => {
    deletedElsewhere();
    await overlappingTaps('latest first');

    expect(logs()).toEqual([]);
    expect(counts()).toEqual([4, 0, 0]);
    expect(ITEMS.map((id) => row(id).last_worn_on)).toEqual([OLD, null, null]);
    expect(h.toasts.error).toHaveLength(2);
    expect(h.toasts.error).not.toContain(MAY_BE_COUNTED());
  });

  it('taken back as they landed: every count is as it was, and an item never worn has no last-worn date', async () => {
    deletedElsewhere();
    await overlappingTaps('as they landed');

    expect(logs()).toEqual([]);
    expect(counts()).toEqual([4, 0, 0]);
    // No wear left is no date: these said "worn today" at 0 wears.
    expect([row('jeans').last_worn_on, row('boots').last_worn_on]).toEqual([null, null]);
    expect(h.toasts.error).toHaveLength(2);
  });

  it('with one of them committing, the date is the committed wear\'s', async () => {
    // Only phone A's log is refused; phone B's commits.
    let refusals = 1;
    h.fault = (table, calls) => (isLog(table, calls) && refusals-- > 0 ? { code: '57014', message: 'canceling statement due to statement timeout' } : null);
    await overlappingTaps('as they landed');

    expect(logs()).toHaveLength(1);
    expect(counts()).toEqual([5, 1, 1]);
    expect(ITEMS.map((id) => row(id).last_worn_on)).toEqual([TODAY, TODAY, TODAY]);
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

  it('two failed taps taken back as they landed leave an item worn before at today\'s date (HD2)', async () => {
    deletedElsewhere();
    await overlappingTaps('as they landed');

    // The count is exact. The date is not: phone A had to keep today for
    // phone B's wear, which might have committed, and phone B then put back
    // the "today" it read from phone A's. One date column with no history
    // cannot say otherwise; lib/closet/wear.ts states this limit rather than
    // claiming the date is rolled back.
    expect(logs()).toEqual([]);
    expect(row('hoodie').wear_count).toBe(4);
    expect(row('hoodie').last_worn_on).toBe(TODAY);
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

  /** Two wears land, A then B, and are taken back in the order given (HD2). */
  async function overlapping(row: { wear_count: number; last_worn_on: string | null }, order: 'AB' | 'BA') {
    const s = store(row);
    const landed: LandedWear[] = [];
    expect(await bumpWearCount(s, 'item-1', TODAY, landed)).toEqual({ ok: true });
    expect(await bumpWearCount(s, 'item-1', TODAY, landed)).toEqual({ ok: true });
    const [a, b] = landed;
    for (const wear of order === 'AB' ? [a, b] : [b, a]) expect(await takeBackWear(s, wear)).toBe(true);
  }

  it('clears the date when it leaves no wear at all, though another wear set that date', async () => {
    // A wear below ours was taken back while ours was on top; ours is the last.
    const row = { wear_count: 1, last_worn_on: TODAY as string | null };
    expect(await takeBackWear(store(row), { id: 'item-1', count: 2, lastWornBefore: TODAY })).toBe(true);
    expect(row).toEqual({ wear_count: 0, last_worn_on: null });
  });

  it('two overlapping wears on an item never worn: no count and no date, in either order', async () => {
    for (const order of ['AB', 'BA'] as const) {
      const row = { wear_count: 0, last_worn_on: null as string | null };
      await overlapping(row, order);
      expect(row, order).toEqual({ wear_count: 0, last_worn_on: null });
    }
  });

  it('two overlapping wears on an item worn before: the count either way, the old date only latest first (the stated limit)', async () => {
    const latestFirst = { wear_count: 4, last_worn_on: OLD as string | null };
    await overlapping(latestFirst, 'BA');
    expect(latestFirst).toEqual({ wear_count: 4, last_worn_on: OLD });

    const asLanded = { wear_count: 4, last_worn_on: OLD as string | null };
    await overlapping(asLanded, 'AB');
    expect(asLanded).toEqual({ wear_count: 4, last_worn_on: TODAY });
  });
});
