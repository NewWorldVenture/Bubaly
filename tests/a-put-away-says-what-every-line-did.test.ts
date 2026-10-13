// "Put it in the pantry" says what happened to every bought line, even when
// one of them failed.
//
// AUD-1041-PUTAWAY-RESULTS. A trip is settled line by line, so one result can
// carry a line taken off the list WITHOUT being counted (the pantry keeps that
// item in another unit: "1 cup" of rice against "3 kg") beside a line that
// failed. The modal returned on the failure before it reached the manual-count
// warning: the family heard only about the failure, and since the mismatched
// line was already off the list, the retry never reached it again — the one
// time it could be named was lost.
//
// The real ShoppingModule, its real server action and the real service,
// against an in-memory database (tests/helpers/module-harness.tsx). The unit
// compare-and-set interleavings live in
// tests/putting-groceries-away-counts-like-the-list.test.ts.
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, withFaults, type FaultCall } from './helpers/in-memory-supabase';
import { byName, click, form, nodes, render, submit, text } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
const server = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/lib/hooks/use-realtime-query', async () => (await import('./helpers/module-harness')).realtimeQueryModule(h));
vi.mock('@/lib/supabase/client', async () => (await import('./helpers/module-harness')).supabaseClientModule(h));
vi.mock('@/components/app/app-context', async () => (await import('./helpers/module-harness')).appContextModule(h));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/modal', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/input', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/states', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/badge', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/app/page-header', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ai/ai-insight', async () => (await import('./helpers/module-harness')).ui);
// The server action runs for real, as the signed-in parent, on the same
// database — through `server.db`, which a case may wrap to fail one call.
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({ user: { id: h.app.userId }, active: {
    familyId: h.app.familyId, role: 'parent', member: { id: 'member-1' }, family: { timezone: 'UTC', name: 'Fixture family' },
  } }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => server.db }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { ShoppingModule } = await import('@/components/modules/shopping-module');

const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
const LIST = 'list-1';
let db: ReturnType<typeof createInMemorySupabase>;

const RICE_WARNING = t('shoppingModule.countTheseInThePantry', { names: 'Rice (cup → kg)' });

/** Rice is stocked in kilograms and bought by the cup; it comes first. */
function seedTrip() {
  const family = h.app.familyId;
  db.seed('grocery_lists', [{ id: LIST, family_id: family, name: 'Groceries', created_by: h.app.userId }]);
  db.seed('grocery_items', [
    { id: 'i-rice', family_id: family, list_id: LIST, name: 'Rice', quantity: '1 cup', is_checked: true, created_at: '2026-10-12T09:00:00.000Z' },
    { id: 'i-milk', family_id: family, list_id: LIST, name: 'Milk', quantity: '1', is_checked: true, created_at: '2026-10-12T09:00:01.000Z' },
    { id: 'i-eggs', family_id: family, list_id: LIST, name: 'Eggs', quantity: '12', is_checked: true, created_at: '2026-10-12T09:00:02.000Z' },
  ]);
  db.seed('pantry_items', [
    { id: 'p-rice', family_id: family, name: 'Rice', quantity: 3, unit: 'kg' },
    { id: 'p-milk', family_id: family, name: 'Milk', quantity: 1, unit: null },
  ]);
}

/** Answer one server call with an outage while `failing.on` is true. */
const failing = { on: false };
function serverFails(when: (table: string, calls: FaultCall[]) => boolean) {
  failing.on = true;
  server.db = withFaults(db, (table, calls) =>
    (failing.on && when(table, calls) ? { code: '08006', message: 'connection reset by peer' } : null));
}

beforeEach(() => {
  resetHookSlots(h.hooks);
  db = createInMemorySupabase({ defaults: {
    grocery_items: { quantity: null, category: null, is_checked: false, source_meal_id: null, idempotency_key: null },
    grocery_lists: { is_archived: false, archived_at: null, store: null, list_icon: null, list_color: null, sort_order: 0 },
    pantry_items: { quantity: 1, unit: null, location: 'pantry', expires_at: null, category: null, low_threshold: null, is_staple: false, notes: null },
  } });
  h.db = db;
  server.db = db;
  failing.on = false;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.toasts = { success: [], error: [] }; h.confirmAnswer = true; h.timeZone = 'UTC';
  vi.spyOn(console, 'error').mockImplementation(() => {});
  seedTrip();
});
afterEach(() => vi.restoreAllMocks());

const screen = (): ReactNode => render(h.hooks, createElement(ShoppingModule));
const pantry = () => Object.fromEntries(db.table('pantry_items')
  .map((row) => [row.name as string, `${String(row.quantity)}${row.unit ? ` ${String(row.unit)}` : ''}`]));
const onTheList = () => db.table('grocery_items')
  .map((row) => `${String(row.name)}${row.is_checked ? ' (ticked)' : ''}`);
const boughtModal = (tree: ReactNode) =>
  nodes(tree).find((node) => node.props.role === 'dialog' && node.props['aria-label'] === t('shoppingModule.bought'));
/** What the open modal lists under "What you bought". */
const modalLines = (tree: ReactNode) =>
  nodes(boughtModal(tree)).filter((node) => node.type === 'li').map((node) => text(node).trim());

async function putAway() {
  await submit(form(screen()));
}

describe('a put-away that partly fails still says which lines to count by hand', () => {
  it('a line the pantry refused, beside a cleared unit mismatch: both are said, and the retry adds only the refused line', async () => {
    // The pantry cannot be read for the eggs, the way an outage answers.
    serverFails((table, calls) => table === 'pantry_items'
      && calls.some((c) => c.method === 'ilike' && /egg/i.test(String(c.args[1]))));
    await click(byName(screen(), t('shoppingModule.bought')));
    expect(modalLines(screen())).toEqual(['Rice1 cup', 'Milk1', 'Eggs12']);

    await putAway();

    expect(h.toasts.error).toEqual([t('shoppingModule.couldNotPutTheseIn', { names: 'Eggs' }), RICE_WARNING]);
    expect(h.toasts.success).toEqual([t('shoppingModule.putItemsInYourPantry', { count: 1 })]);
    expect(pantry()).toEqual({ Rice: '3 kg', Milk: '2' });
    // Rice and milk are off the list; the eggs are handed back, ticked.
    expect(onTheList()).toEqual(['Eggs (ticked)']);
    // The modal stays open on what is left to put away.
    expect(boughtModal(screen())).toBeDefined();
    expect(modalLines(screen())).toEqual(['Eggs12']);

    // The pantry answers again, and the family taps again.
    failing.on = false;
    h.toasts = { success: [], error: [] };
    await putAway();

    // The eggs land once; the milk is not added a second time, and the rice
    // keeps the count the family is to fix by hand.
    expect(pantry()).toEqual({ Rice: '3 kg', Milk: '2', Eggs: '12' });
    expect(onTheList()).toEqual([]);
    expect(h.toasts.error).toEqual([]);
    expect(h.toasts.success).toEqual([t('shoppingModule.putItemsInYourPantry', { count: 1 })]);
    expect(boughtModal(screen())).toBeUndefined();
  });

  it('a line put away that would not clear, beside a cleared unit mismatch: both are said, and the retry counts nothing twice', async () => {
    // The milk lands in the pantry and then cannot be removed from the list.
    serverFails((table, calls) => table === 'grocery_items'
      && calls.some((c) => c.method === 'delete')
      && calls.some((c) => c.method === 'eq' && c.args[1] === 'i-milk'));
    await click(byName(screen(), t('shoppingModule.bought')));

    await putAway();

    expect(h.toasts.error).toEqual([t('shoppingModule.theseAreInYourPantry', { names: 'Milk' }), RICE_WARNING]);
    expect(h.toasts.success).toEqual([t('shoppingModule.putItemsInYourPantry', { count: 2 })]);
    expect(pantry()).toEqual({ Rice: '3 kg', Milk: '2', Eggs: '12' });
    // The milk's claim un-ticked it, so nothing on the list is left to count.
    expect(onTheList()).toEqual(['Milk']);
    expect(boughtModal(screen())).toBeDefined();
    expect(modalLines(screen())).toEqual([]);

    failing.on = false;
    h.toasts = { success: [], error: [] };
    await putAway();

    expect(pantry()).toEqual({ Rice: '3 kg', Milk: '2', Eggs: '12' });
    expect(h.toasts.success).toEqual([]);
    expect(h.toasts.error).toHaveLength(1);
    expect(h.toasts.error).not.toContain(RICE_WARNING);
  });
});

describe('controls', () => {
  it('a unit mismatch on a trip where every other line lands is said, and the modal closes', async () => {
    await click(byName(screen(), t('shoppingModule.bought')));

    await putAway();

    expect(h.toasts.error).toEqual([RICE_WARNING]);
    expect(h.toasts.success).toEqual([t('shoppingModule.putItemsInYourPantry', { count: 2 })]);
    expect(pantry()).toEqual({ Rice: '3 kg', Milk: '2', Eggs: '12' });
    expect(onTheList()).toEqual([]);
    expect(boughtModal(screen())).toBeUndefined();
  });

  it('a refused line with no mismatch and nothing else landed says only the failure', async () => {
    db.replace('grocery_items', db.table('grocery_items').filter((row) => row.id === 'i-eggs'));
    serverFails((table) => table === 'pantry_items');
    await click(byName(screen(), t('shoppingModule.bought')));

    await putAway();

    expect(h.toasts.error).toEqual([t('shoppingModule.couldNotPutTheseIn', { names: 'Eggs' })]);
    expect(h.toasts.success).toEqual([]);
    expect(pantry()).toEqual({ Rice: '3 kg', Milk: '1' });
    expect(onTheList()).toEqual(['Eggs (ticked)']);
    expect(boughtModal(screen())).toBeDefined();
  });
});
