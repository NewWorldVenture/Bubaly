// N4 — editing a person could make them their own ancestor, and then everyone
// in the loop vanished from the tree.
//
// The edit form's parent picker left out only the person themselves, never
// their descendants, and the update wrote `parent_node_id` without asking
// whether the chain now looped (0082 has no constraint). Set Grandma's parent
// to her grandchild and every person in the loop has a parent in the map, so
// buildTree found no root for any of them: Grandma, Mom and the child left the
// tree AND the generations view — the only two views with edit and delete —
// while the People count still counted them. Nothing in the app could repair it.
//
// Driven through the REAL module against an in-memory database
// (tests/helpers/module-harness.tsx).
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { allByName, byName, change, click, form, has, nodes, render, submit, type Node } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/lib/hooks/use-realtime-query', async () => (await import('./helpers/module-harness')).realtimeQueryModule(h));
vi.mock('@/lib/supabase/client', async () => (await import('./helpers/module-harness')).supabaseClientModule(h));
vi.mock('@/components/app/app-context', async () => (await import('./helpers/module-harness')).appContextModule(h));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/modal', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/input', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/avatar', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/states', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/app/page-header', async () => (await import('./helpers/module-harness')).ui);

const { FamilyTreeModule } = await import('@/components/modules/family-tree-module');

const t = (key: string) => translate(SOURCE_MESSAGES, key);
const FAMILY = h.app.familyId;
let db: InMemorySupabase;

const person = (id: string, name: string, parent: string | null) => ({
  id, family_id: FAMILY, name, relationship: 'other', parent_node_id: parent, birth_year: null, death_year: null,
  birth_place: null, bio: null, member_id: null, created_by: 'user-1',
});

beforeEach(() => {
  resetHookSlots(h.hooks);
  db = createInMemorySupabase();
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.toasts = { success: [], error: [] };
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const screen = () => render(h.hooks, createElement(FamilyTreeModule));

/** The generations view lists everyone the tree placed, each with a named Edit. */
async function generations(): Promise<ReactNode> {
  await click(byName(screen(), t('familyTree.generations'), 'button'));
  return screen();
}

/** Open the edit form for the person whose card names them. */
async function edit(name: string): Promise<ReactNode> {
  const tree = await generations();
  const cards = nodes(tree).filter((n) => n.type === 'div' && String(n.props.className).includes('rounded-2xl border p-4'));
  const card = cards.find((c) => has(c.props.children as ReactNode, name));
  expect(card, `${name} is on the generations view`).toBeDefined();
  await click(byName(card!.props.children as ReactNode, t('a11y.edit')));
  return screen();
}

/** The "Parent in tree" picker: the select that offers "Root (no parent)". */
function parentPicker(tree: ReactNode): Node {
  const selects = nodes(form(tree)).filter((n) => n.type === 'select');
  const picker = selects.find((s) => nodes(s.props.children as ReactNode).some((o) => o.type === 'option' && o.props.value === ''
    && has(o.props.children as ReactNode, t('familyTree.rootNoParent'))));
  expect(picker, 'the parent picker is on the form').toBeDefined();
  return picker!;
}
const offered = (picker: Node) => nodes(picker.props.children as ReactNode).filter((o) => o.type === 'option').map((o) => o.props.value);

describe('a person cannot be made their own ancestor', () => {
  beforeEach(() => {
    db.seed('family_tree_nodes', [
      person('grandma', 'Grandma Rose', null),
      person('mom', 'Mom', 'grandma'),
      person('kid', 'Kid', 'mom'),
      person('uncle', 'Uncle Joe', null),
    ]);
  });

  it('the parent picker leaves out the person and everyone below them', async () => {
    const options = offered(parentPicker(await edit('Grandma Rose')));
    expect(options).toContain('uncle');
    expect(options).not.toContain('grandma');
    expect(options).not.toContain('mom');
    expect(options).not.toContain('kid');
  });

  it('a save that would close a loop is refused and nothing is written', async () => {
    const tree = await edit('Grandma Rose');
    change(parentPicker(tree), 'kid');
    await submit(form(screen()));

    expect(h.toasts.error).toContain(t('familyTreeModule.cannotBeTheirOwnAncestor'));
    expect(db.table('family_tree_nodes').find((n) => n.id === 'grandma')?.parent_node_id).toBeNull();
  });

  it('a save that does not close a loop still goes through', async () => {
    const tree = await edit('Grandma Rose');
    change(parentPicker(tree), 'uncle');
    await submit(form(screen()));

    expect(db.table('family_tree_nodes').find((n) => n.id === 'grandma')?.parent_node_id).toBe('uncle');
    expect(h.toasts.success).toContain(t('familyTreeModule.updated'));
  });
});

describe('a loop already in the database stays on the tree and can be repaired', () => {
  beforeEach(() => {
    db.seed('family_tree_nodes', [
      person('grandma', 'Grandma Rose', 'kid'),
      person('mom', 'Mom', 'grandma'),
      person('kid', 'Kid', 'mom'),
      person('uncle', 'Uncle Joe', null),
    ]);
  });

  it('everyone in the loop is shown, on the tree and in the generations view', async () => {
    expect(has(screen(), 'Grandma Rose')).toBe(true);
    const tree = await generations();
    for (const name of ['Grandma Rose', 'Mom', 'Kid', 'Uncle Joe']) expect(has(tree, name), name).toBe(true);
    expect(allByName(tree, t('a11y.edit'))).toHaveLength(4);
  });

  it('editing the lifted person back to the root repairs it', async () => {
    const tree = await edit('Grandma Rose');
    change(parentPicker(tree), '');
    await submit(form(screen()));

    expect(db.table('family_tree_nodes').find((n) => n.id === 'grandma')?.parent_node_id).toBeNull();
  });
});
