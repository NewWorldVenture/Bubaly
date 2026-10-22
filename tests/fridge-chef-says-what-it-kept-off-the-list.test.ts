import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { byName, click, nodes, render, settle, type Node } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

// Fridge Chef's "Add to grocery", as a family reads its answer.
//
// The route answers what it added and what the family's allergies changed on
// the way: a swap ("butter → olive oil") or an item it kept off the list
// entirely ({ to: null }). Both went into one "Changed for your family's
// allergies:" toast, where a bare "shrimp" read as though the shrimp had been
// added; and a recipe whose every item was kept off still said "Added 0 items
// to your grocery list."
//
// The REAL component: its photo scan and its grocery call, against a stubbed
// fetch, FileReader and object URL.

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);

const { FridgeChef } = await import('@/components/meals/fridge-chef');
const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);

const RECIPE = { title: 'Garlic stir-fry', have: ['rice'], need: ['shrimp', 'butter'], steps: '', minutes: 20, allergenConflict: null };

class PhotoReader {
  result = 'data:image/png;base64,aGk=';
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readAsDataURL() { this.onload?.(); }
}

beforeEach(() => {
  resetHookSlots(h.hooks);
  h.toasts = { success: [], error: [] };
  vi.stubGlobal('FileReader', PhotoReader);
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fridge');
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** Scan a photo that finds one recipe, then answer its grocery call with `reply`. */
async function scanned(reply: Record<string, unknown>): Promise<ReactNode> {
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(Response.json({ recipes: [RECIPE] }))
    .mockResolvedValueOnce(Response.json(reply)));
  const first = render(h.hooks, createElement(FridgeChef));
  const input = nodes(first).find((n) => n.type === 'input' && n.props.type === 'file') as Node;
  (input.props.onChange as (event: unknown) => void)({ target: { files: [new File(['x'], 'fridge.png', { type: 'image/png' })] } });
  for (let pass = 0; pass < 3; pass++) await settle();
  return render(h.hooks, createElement(FridgeChef));
}

describe('Fridge Chef says what the allergies kept off the grocery list', () => {
  it('an item kept off is said as kept off, and nothing added is not "Added 0 items"', async () => {
    const tree = await scanned({ added: 0, swapped: [{ from: 'shrimp', to: null }, { from: 'butter', to: null }] });
    await click(byName(tree, 'Add 2 to grocery'));

    expect(h.toasts.success).toEqual([]);
    expect(h.toasts.error).toEqual([t('fridgeChef.leftOffForAllergies', { names: 'shrimp, butter' })]);
  });

  it('a swap is said as a change, and a kept-off item apart from it, beside what was added', async () => {
    const tree = await scanned({ added: 1, swapped: [{ from: 'butter', to: 'olive oil' }, { from: 'shrimp', to: null }] });
    await click(byName(tree, 'Add 2 to grocery'));

    expect(h.toasts.success).toEqual([t('fridgeChef.addedItemToGroceryOne', { count: 1 })]);
    expect(h.toasts.error).toEqual([
      t('fridgeChef.changedForAllergies', { names: 'butter → olive oil' }),
      t('fridgeChef.leftOffForAllergies', { names: 'shrimp' }),
    ]);
  });

  it('control: nothing changed, everything added', async () => {
    const tree = await scanned({ added: 2, swapped: [] });
    await click(byName(tree, 'Add 2 to grocery'));

    expect(h.toasts.success).toEqual([t('fridgeChef.addedItemsToGroceryMany', { count: 2 })]);
    expect(h.toasts.error).toEqual([]);
  });
});
