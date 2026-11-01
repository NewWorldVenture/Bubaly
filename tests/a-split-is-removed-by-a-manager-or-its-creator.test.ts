// N4-sibling/non-creator — the Trash on a split deletes the split, and its
// shares go with it (expense_split_shares.split_id is ON DELETE CASCADE).
// 0481 lets a share be deleted only by a manager or by the member who created
// its split (expense_split_shares_delete), but keeps expense_splits_delete at
// any member but a guest. Round 2 took the Trash from a caregiver only, so a
// teen or a child was still offered it on a parent's split, and the delete
// landed with the shares 0481 refuses them directly. Measured as the teen
// (role authenticated) on a copy with 0001-0486: `delete from
// expense_split_shares where split_id = <the parent's split>` got 0, and
// `delete from expense_splits where id = <the parent's split> and family_id =
// <family>` got 1, the cascade taking those same shares. The Trash now follows
// the share rule: a manager on every split, anyone else on the splits they
// created. Narrowing expense_splits itself is the owner's SQL.
//
// Driven through the REAL ExpensesModule (tests/helpers/module-harness.tsx)
// against the in-memory database.
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { allByName, click, nodes, render, settle, text, type Node } from './helpers/module-harness';
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
const FAMILY = '0f0f0f0f-0000-4000-8000-000000000001';
const MEMBERS = [
  { id: 'm-parent', family_id: FAMILY, display_name: 'Ada', role: 'parent', is_active: true, color: null, birthday: null },
  { id: 'm-adult', family_id: FAMILY, display_name: 'Bo', role: 'adult', is_active: true, color: null, birthday: null },
  { id: 'm-teen', family_id: FAMILY, display_name: 'Teen', role: 'teen', is_active: true, color: null, birthday: null },
  { id: 'm-kid', family_id: FAMILY, display_name: 'Kid', role: 'child', is_active: true, color: null, birthday: null },
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
  vi.stubGlobal('confirm', () => true);
  db.seed('expense_splits', [
    // The parent's split, and the teen's own.
    { id: 'split-parent', family_id: FAMILY, description: 'Groceries', total_cents: 4000, category: 'Groceries', paid_by: 'm-parent', spent_on: '2026-10-20', created_by: 'u-m-parent' },
    { id: 'split-teen', family_id: FAMILY, description: 'Pizza', total_cents: 1200, category: 'Dining', paid_by: 'm-teen', spent_on: '2026-10-21', created_by: 'u-m-teen' },
  ]);
  db.seed('expense_split_shares', [
    { id: 'share-1', family_id: FAMILY, split_id: 'split-parent', member_id: 'm-parent', share_cents: 2000, settled: true, settled_at: null },
    { id: 'share-2', family_id: FAMILY, split_id: 'split-parent', member_id: 'm-teen', share_cents: 2000, settled: false, settled_at: null },
    { id: 'share-3', family_id: FAMILY, split_id: 'split-teen', member_id: 'm-teen', share_cents: 600, settled: true, settled_at: null },
    { id: 'share-4', family_id: FAMILY, split_id: 'split-teen', member_id: 'm-kid', share_cents: 600, settled: false, settled_at: null },
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
const trashOn = (tree: ReactNode, description: string) => allByName(card(tree, description), t('expenses.delete'));

describe('a teen on the Expenses page', () => {
  it('is offered no Trash on a parent\'s split, whose shares 0481 does not let them delete', async () => {
    as('m-teen');
    const tree = mounted();
    await settle();

    expect(text(card(tree, 'Groceries'))).toContain('Ada');
    expect(trashOn(tree, 'Groceries')).toHaveLength(0);
  });

  it('keeps the Trash on the split they created, and it removes that split', async () => {
    as('m-teen');
    const tree = mounted();
    await settle();

    expect(trashOn(tree, 'Pizza')).toHaveLength(1);
    await click(trashOn(tree, 'Pizza')[0]);

    expect(db.table('expense_splits').map((row) => row.id)).toEqual(['split-parent']);
    expect(h.toasts.success).toContain(t('expensesModule.deleted'));
    expect(h.toasts.error).toEqual([]);
  });
});

describe('a child on the Expenses page', () => {
  it('is offered no Trash on splits other members created', async () => {
    as('m-kid');
    const tree = mounted();
    await settle();

    expect(text(tree)).toContain('Groceries');
    expect(text(tree)).toContain('Pizza');
    expect(allByName(tree, t('expenses.delete'))).toHaveLength(0);
  });
});

describe('control: a manager', () => {
  it.each([['a parent', 'm-parent'], ['an adult', 'm-adult']])('%s keeps the Trash on every split', async (_who, memberId) => {
    as(memberId);
    const tree = mounted();
    await settle();

    expect(trashOn(tree, 'Groceries')).toHaveLength(1);
    expect(trashOn(tree, 'Pizza')).toHaveLength(1);
  });

  it('a parent removes the teen\'s split with it', async () => {
    as('m-parent');
    const tree = mounted();
    await settle();

    await click(trashOn(tree, 'Pizza')[0]);

    expect(db.table('expense_splits').map((row) => row.id)).toEqual(['split-parent']);
    expect(h.toasts.success).toContain(t('expensesModule.deleted'));
  });
});
