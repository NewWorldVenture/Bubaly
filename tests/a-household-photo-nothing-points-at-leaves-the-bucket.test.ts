import { createElement, type ComponentType, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { FAMILY, HOUSEHOLD_DEFAULTS } from './helpers/household-fixtures';
import { byName, click, form, nodes, render, settle, submit, type Node } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

// H2 — closet and inventory photos stayed in the public family-media bucket
// after the item was deleted, its photo replaced or removed, or the form that
// uploaded it was closed unsaved.
//
// `family-media` serves an object to anyone holding its URL, and these paths
// had been sent to every member's client in row reads. A wardrobe item deleted
// behind "this cannot be undone" — sleepwear and swimwear are categories —
// stayed readable by a member removed since, with nothing in the product left
// pointing at it. photos-module.tsx fixed exactly this under SEC-015; these two
// modules never imported the removal.
//
// Each case drives the REAL module (tests/helpers/module-harness.tsx) against
// an in-memory database and a storage bucket that, like Supabase, answers a
// refused delete with `error: null` and an empty list.

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
const { InventoryModule } = await import('@/components/modules/inventory-module');

const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
let db: ReturnType<typeof createInMemorySupabase>;

beforeEach(() => {
  resetHookSlots(h.hooks);
  db = createInMemorySupabase({ defaults: HOUSEHOLD_DEFAULTS });
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.storage = { objects: new Map(), refused: new Set() };
  h.toasts = { success: [], error: [] }; h.confirmAnswer = true; h.timeZone = 'UTC';
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const bucket = () => [...(h.storage.objects.get('family-media') ?? [])].sort();
const store = (...paths: string[]) => { h.storage.objects.set('family-media', new Set(paths)); };
const screen = (Component: ComponentType) => render(h.hooks, createElement(Component));

/** Choose a file in the open form's photo input, as the browser would. */
async function choosePhoto(tree: ReactNode, name: string) {
  const input = nodes(form(tree)).find((node) => node.type === 'input' && node.props.type === 'file') as Node;
  (input.props.onChange as (event: unknown) => void)({ target: { files: [{ name, size: 2048 }] } });
  await settle();
}

const MODULES = [
  { name: 'closet', Component: ClosetModule, table: 'wardrobe_items', folder: 'closet', kept: 'closetModule.itemRemovedButPhotoKept', removed: 'closetModule.itemRemoved', removeLabel: 'closet.remove', cancel: 'closet.cancel' },
  { name: 'inventory', Component: InventoryModule, table: 'inventory_items', folder: 'inventory', kept: 'inventoryModule.itemRemovedButPhotoKept', removed: 'inventoryModule.itemRemoved', removeLabel: 'inventory.remove', cancel: 'inventory.cancel' },
] as const;

describe.each(MODULES)('$name: a photo nothing points at is removed from family-media', (m) => {
  const photo = `${FAMILY}/${m.folder}/11111111-1111-4111-8111-111111111111.jpg`;

  it('deleting the item deletes its photo', async () => {
    db.seed(m.table, [{ id: 'item-1', name: 'Swim shorts', photo_path: photo }]);
    store(photo);

    await click(byName(screen(m.Component), t('itemAction.remove', { name: 'Swim shorts' })));

    expect(db.table(m.table)).toEqual([]);
    expect(bucket()).toEqual([]);
    expect(h.toasts.success).toContain(t(m.removed));
  });

  it('says so when storage keeps the photo, instead of claiming a clean delete', async () => {
    db.seed(m.table, [{ id: 'item-1', name: 'Swim shorts', photo_path: photo }]);
    store(photo);
    h.storage.refused.add(photo);

    await click(byName(screen(m.Component), t('itemAction.remove', { name: 'Swim shorts' })));

    expect(db.table(m.table)).toEqual([]);
    expect(bucket()).toEqual([photo]);
    expect(h.toasts.error).toContain(t(m.kept));
    expect(h.toasts.success).not.toContain(t(m.removed));
  });

  it('never deletes an object outside the item\'s own folder', async () => {
    const elsewhere = `${FAMILY}/photos/22222222-2222-4222-8222-222222222222.jpg`;
    db.seed(m.table, [{ id: 'item-1', name: 'Swim shorts', photo_path: elsewhere }]);
    store(elsewhere);

    await click(byName(screen(m.Component), t('itemAction.remove', { name: 'Swim shorts' })));

    expect(db.table(m.table)).toEqual([]);
    expect(bucket()).toEqual([elsewhere]);
  });

  it('replacing the photo and saving removes the old one and keeps the new one', async () => {
    db.seed(m.table, [{ id: 'item-1', name: 'Swim shorts', photo_path: photo }]);
    store(photo);
    await click(byName(screen(m.Component), t('itemAction.edit', { name: 'Swim shorts' })));
    await choosePhoto(screen(m.Component), 'new.jpg');
    const uploaded = bucket().find((path) => path !== photo)!;
    expect(uploaded).toMatch(new RegExp(`^${FAMILY}/${m.folder}/.+\\.jpg$`));

    await submit(form(screen(m.Component)));

    expect(db.table(m.table)[0].photo_path).toBe(uploaded);
    expect(bucket()).toEqual([uploaded]);
  });

  it('removing the photo and saving removes it from the bucket', async () => {
    db.seed(m.table, [{ id: 'item-1', name: 'Swim shorts', photo_path: photo }]);
    store(photo);
    await click(byName(screen(m.Component), t('itemAction.edit', { name: 'Swim shorts' })));
    await click(byName(form(screen(m.Component)), t(m.removeLabel)));

    await submit(form(screen(m.Component)));

    expect(db.table(m.table)[0].photo_path).toBeNull();
    expect(bucket()).toEqual([]);
  });

  it('closing the form unsaved removes what it uploaded and leaves the saved photo alone', async () => {
    db.seed(m.table, [{ id: 'item-1', name: 'Swim shorts', photo_path: photo }]);
    store(photo);
    await click(byName(screen(m.Component), t('itemAction.edit', { name: 'Swim shorts' })));
    await choosePhoto(screen(m.Component), 'first.jpg');
    await choosePhoto(screen(m.Component), 'second.jpg');
    expect(bucket()).toHaveLength(3);

    await click(byName(form(screen(m.Component)), t(m.cancel)));

    expect(bucket()).toEqual([photo]);
    expect(db.table(m.table)[0].photo_path).toBe(photo);
  });

  it('an upload in a new item\'s form that is never saved does not stay behind', async () => {
    await click(byName(screen(m.Component), t(m.name === 'closet' ? 'closet.addItem' : 'inventory.addItem')));
    await choosePhoto(screen(m.Component), 'draft.jpg');
    expect(bucket()).toHaveLength(1);

    await click(byName(form(screen(m.Component)), t(m.cancel)));

    expect(bucket()).toEqual([]);
    expect(db.table(m.table)).toEqual([]);
  });
});
