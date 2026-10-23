// N4-sibling/settle — the settle toggle on a share is a share UPDATE. 0481's
// expense_split_shares_update lets a member who is not a manager (and not a
// guest or a caregiver) settle only their own share (is_self_member(member_id)),
// or a share of a split they created (created_by = auth.uid()) or paid
// (is_self_member(paid_by)). The module offered a teen or a child the toggle
// on every share of every split, and a toggle on anyone else's share of a
// parent's split came back "not saved" on every try. Measured as the teen
// (role authenticated) on a copy with 0001-0486: `update
// expense_split_shares set settled = true, settled_at = now() where id = <the
// parent's own share on the parent's split> and family_id = <family>` got 0;
// the teen's own share, and the child's share of a split the teen created and
// paid, each got 1. The toggle now follows that rule; any other share is the
// read-only chip a caregiver sees.
//
// Driven through the REAL ExpensesModule (tests/helpers/module-harness.tsx)
// against the in-memory database.
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { click, nodes, render, settle, text, type Node } from './helpers/module-harness';
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
vi.mock('@/components/ui/states', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/avatar', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ai/ai-insight', async () => (await import('./helpers/module-harness')).ui);

const { ExpensesModule } = await import('@/components/modules/expenses-module');

const t = (key: string) => translate(SOURCE_MESSAGES, key);
const FAMILY = '0f0f0f0f-0000-4000-8000-000000000002';
const MEMBERS = [
  { id: 'm-parent', family_id: FAMILY, display_name: 'Ada', role: 'parent', is_active: true, color: null, birthday: null },
  { id: 'm-adult', family_id: FAMILY, display_name: 'Bo', role: 'adult', is_active: true, color: null, birthday: null },
  { id: 'm-teen', family_id: FAMILY, display_name: 'Teen', role: 'teen', is_active: true, color: null, birthday: null },
  { id: 'm-kid', family_id: FAMILY, display_name: 'Kid', role: 'child', is_active: true, color: null, birthday: null },
  { id: 'm-carer', family_id: FAMILY, display_name: 'Carer', role: 'caregiver', is_active: true, color: null, birthday: null },
];

function as(memberId: string) {
  const self = MEMBERS.find((m) => m.id === memberId)!;
  h.app = { ...h.app, familyId: FAMILY, userId: `u-${memberId}`, members: MEMBERS, selfMember: self, family: { id: FAMILY, name: 'Fixture', timezone: 'UTC' } };
  (h.app as unknown as { role: string }).role = self.role;
}

let db: InMemorySupabase;

beforeEach(() => {
  resetHookSlots(h.hooks);
  db = createInMemorySupabase();
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.toasts = { success: [], error: [] }; h.timeZone = 'UTC';
  db.seed('expense_splits', [
    // The parent's split, which the parent created and paid.
    { id: 'split-parent', family_id: FAMILY, description: 'Groceries', total_cents: 6000, category: 'Groceries', paid_by: 'm-parent', spent_on: '2026-10-20', created_by: 'u-m-parent' },
    // The teen's own split, created and paid by the teen.
    { id: 'split-teen', family_id: FAMILY, description: 'Pizza', total_cents: 1200, category: 'Dining', paid_by: 'm-teen', spent_on: '2026-10-21', created_by: 'u-m-teen' },
    // A split the parent created and the teen paid.
    { id: 'split-paid', family_id: FAMILY, description: 'Cinema', total_cents: 2400, category: 'Entertainment', paid_by: 'm-teen', spent_on: '2026-10-22', created_by: 'u-m-parent' },
  ]);
  db.seed('expense_split_shares', [
    { id: 'share-gp', family_id: FAMILY, split_id: 'split-parent', member_id: 'm-parent', share_cents: 2000, settled: false, settled_at: null },
    { id: 'share-gt', family_id: FAMILY, split_id: 'split-parent', member_id: 'm-teen', share_cents: 2000, settled: false, settled_at: null },
    { id: 'share-gk', family_id: FAMILY, split_id: 'split-parent', member_id: 'm-kid', share_cents: 2000, settled: false, settled_at: null },
    { id: 'share-pt', family_id: FAMILY, split_id: 'split-teen', member_id: 'm-teen', share_cents: 600, settled: true, settled_at: null },
    { id: 'share-pk', family_id: FAMILY, split_id: 'split-teen', member_id: 'm-kid', share_cents: 600, settled: false, settled_at: null },
    { id: 'share-cp', family_id: FAMILY, split_id: 'split-paid', member_id: 'm-parent', share_cents: 1200, settled: false, settled_at: null },
    { id: 'share-ck', family_id: FAMILY, split_id: 'split-paid', member_id: 'm-kid', share_cents: 1200, settled: false, settled_at: null },
  ]);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function mounted(): ReactNode {
  return render(h.hooks, createElement(ExpensesModule));
}
/** The card of the split described as `description`. */
function card(tree: ReactNode, description: string): Node {
  const found = nodes(tree).find((node) => node.type === 'div'
    && String(node.props.className).startsWith('rounded-xl border border-border bg-surface/40 p-3')
    && text(node).startsWith(`${description} `));
  if (!found) throw new Error(`no split card for ${description}`);
  return found;
}
/** The chip of `name`'s share on that split: a settle toggle (button) or the read-only span. */
function chip(tree: ReactNode, description: string, name: string): Node {
  const found = nodes(card(tree, description)).filter((node) => (node.type === 'button' || node.type === 'span')
    && String(node.props.className).startsWith('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs')
    && text(node).trim().startsWith(`${name} `));
  if (found.length !== 1) throw new Error(`expected one share chip for ${name} on ${description}, found ${found.length}`);
  return found[0];
}
const toggles = (tree: ReactNode, description: string, names: string[]) =>
  names.filter((name) => chip(tree, description, name).type === 'button');

describe('a teen on the Expenses page', () => {
  it('is offered no settle toggle on the parent\'s own share of the parent\'s split, which 0481 refuses them', async () => {
    as('m-teen');
    const tree = mounted();
    await settle();

    expect(chip(tree, 'Groceries', 'Ada').type).toBe('span');
    expect(chip(tree, 'Groceries', 'Kid').type).toBe('span');
    expect(chip(tree, 'Groceries', 'Ada').props.onClick).toBeUndefined();
  });

  it('keeps the toggle on their own share of the parent\'s split, and it settles that share', async () => {
    as('m-teen');
    const tree = mounted();
    await settle();

    expect(toggles(tree, 'Groceries', ['Ada', 'Teen', 'Kid'])).toEqual(['Teen']);
    expect(chip(tree, 'Groceries', 'Teen').props.title).toBe(t('dialogTitle.markSettled'));
    await click(chip(tree, 'Groceries', 'Teen'));

    expect(db.table('expense_split_shares').find((row) => row.id === 'share-gt')?.settled).toBe(true);
    expect(h.toasts.error).toEqual([]);
  });

  it('keeps the toggle on every share of a split they created, and of one they paid', async () => {
    as('m-teen');
    const tree = mounted();
    await settle();

    expect(toggles(tree, 'Pizza', ['Teen', 'Kid'])).toEqual(['Teen', 'Kid']);
    expect(toggles(tree, 'Cinema', ['Ada', 'Kid'])).toEqual(['Ada', 'Kid']);
    await click(chip(tree, 'Pizza', 'Kid'));

    expect(db.table('expense_split_shares').find((row) => row.id === 'share-pk')?.settled).toBe(true);
    expect(h.toasts.error).toEqual([]);
  });
});

describe('a child on the Expenses page', () => {
  it('is offered the toggle on their own shares only', async () => {
    as('m-kid');
    const tree = mounted();
    await settle();

    expect(toggles(tree, 'Groceries', ['Ada', 'Teen', 'Kid'])).toEqual(['Kid']);
    expect(toggles(tree, 'Pizza', ['Teen', 'Kid'])).toEqual(['Kid']);
    expect(toggles(tree, 'Cinema', ['Ada', 'Kid'])).toEqual(['Kid']);
  });
});

describe('control: a manager', () => {
  it.each([['a parent', 'm-parent'], ['an adult', 'm-adult']])('%s keeps the toggle on every share', async (_who, memberId) => {
    as(memberId);
    const tree = mounted();
    await settle();

    expect(toggles(tree, 'Groceries', ['Ada', 'Teen', 'Kid'])).toEqual(['Ada', 'Teen', 'Kid']);
    expect(toggles(tree, 'Pizza', ['Teen', 'Kid'])).toEqual(['Teen', 'Kid']);
    expect(toggles(tree, 'Cinema', ['Ada', 'Kid'])).toEqual(['Ada', 'Kid']);
  });

  it('an adult settles the teen\'s share of the parent\'s split', async () => {
    as('m-adult');
    const tree = mounted();
    await settle();

    await click(chip(tree, 'Groceries', 'Teen'));

    expect(db.table('expense_split_shares').find((row) => row.id === 'share-gt')?.settled).toBe(true);
    expect(h.toasts.error).toEqual([]);
  });
});

describe('control: a caregiver', () => {
  it('still reads every share without a toggle', async () => {
    as('m-carer');
    const tree = mounted();
    await settle();

    expect(toggles(tree, 'Groceries', ['Ada', 'Teen', 'Kid'])).toEqual([]);
    expect(toggles(tree, 'Pizza', ['Teen', 'Kid'])).toEqual([]);
    expect(toggles(tree, 'Cinema', ['Ada', 'Kid'])).toEqual([]);
  });
});
