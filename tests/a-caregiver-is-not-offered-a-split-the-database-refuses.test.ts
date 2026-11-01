// N4 — 0481 refuses a caregiver every expense_split_shares write: the insert
// and update policies both wrap their arms in `family_role(family_id) not in
// ('guest','caregiver')`. The Expenses page (open to a caregiver) still offered
// them "Split an expense" and a settle toggle on every share, so a caregiver's
// split was inserted, its shares refused (42501), the split rolled back and
// the RLS error toasted; and each settle came back "not saved". The screen now
// offers a caregiver only reading the household's splits. (Whether a caregiver
// should settle a share they owe or paid is the owner's decision on that
// policy; it is reported, not changed here.)
//
// N4-sibling: the Trash on every split was still offered. 0481 keeps
// expense_splits_delete at is_family_member, and expense_split_shares.split_id
// is ON DELETE CASCADE, so a caregiver's Trash removed a parent's split AND its
// shares: the share delete 0481 refuses a caregiver directly. The screen's
// comment said "read", and the screen offered a delete. The Trash now goes
// only to a member who writes shares. Narrowing expense_splits itself is the
// owner's SQL. The parent's Trash removes the split by id within the family
// and reads it back, so the write is already scoped and confirmed for when the
// owner's SQL makes the table gated (tests/a-filtered-delete-is-not-a-deletion.test.ts).
//
// Driven through the REAL ExpensesModule (tests/helpers/module-harness.tsx)
// against the in-memory database.
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, withFaults, type FaultCall, type InMemorySupabase } from './helpers/in-memory-supabase';
import { allByName, byName, click, nodes, render, settle, text } from './helpers/module-harness';
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
  { id: 'm-sitter', family_id: FAMILY, display_name: 'Sitter', role: 'caregiver', is_active: true, color: null, birthday: null },
];

function as(memberId: string) {
  const self = MEMBERS.find((m) => m.id === memberId)!;
  h.app = { ...h.app, familyId: FAMILY, userId: `u-${memberId}`, members: MEMBERS, selfMember: self, family: { id: FAMILY, name: 'Fixture', timezone: 'UTC' } };
  (h.app as unknown as { role: string }).role = self.role;
}

/** The database itself, and every builder call the screen sends it, with its arguments. */
let db: InMemorySupabase;
let sent: { table: string; calls: FaultCall[] }[] = [];

beforeEach(() => {
  resetHookSlots(h.hooks);
  db = createInMemorySupabase();
  sent = [];
  h.db = withFaults(db, (table, calls) => { sent.push({ table, calls }); return null; });
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.toasts = { success: [], error: [] }; h.timeZone = 'UTC';
  db.seed('expense_splits', [{ id: 'split-1', family_id: FAMILY, description: 'Groceries', total_cents: 4000, category: 'Groceries', paid_by: 'm-parent', spent_on: '2026-10-20', created_by: 'u-m-parent' }]);
  db.seed('expense_split_shares', [
    { id: 'share-parent', family_id: FAMILY, split_id: 'split-1', member_id: 'm-parent', share_cents: 2000, settled: true, settled_at: null },
    { id: 'share-sitter', family_id: FAMILY, split_id: 'split-1', member_id: 'm-sitter', share_cents: 2000, settled: false, settled_at: null },
  ]);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function mounted(): ReactNode {
  return render(h.hooks, createElement(ExpensesModule));
}
/** The share chips that toggle settled: buttons titled "Mark settled" or "Settled — click to unsettle". */
const settleToggles = (tree: ReactNode) => nodes(tree).filter((node) => node.type === 'button'
  && [t('dialogTitle.markSettled'), t('dialogTitle.settledClickToUnsettle')].includes(String(node.props.title)));

describe('a caregiver on the Expenses page', () => {
  it('reads the household\'s splits and is offered no split or settle the database refuses', async () => {
    as('m-sitter');
    const tree = mounted();
    await settle();

    expect(text(tree)).toContain('Groceries');
    expect(text(tree)).toContain('Sitter');
    expect(allByName(tree, t('expenses.splitAnExpense'))).toHaveLength(0);
    expect(settleToggles(tree)).toHaveLength(0);
    // N4-sibling: no Trash either. Its delete would take the parent's split
    // and, by the cascade, the shares 0481 refuses a caregiver.
    expect(allByName(tree, t('expenses.delete'))).toHaveLength(0);
  });
});

describe('control: a parent', () => {
  it('is offered both', async () => {
    as('m-parent');
    const tree = mounted();
    await settle();

    expect(allByName(tree, t('expenses.splitAnExpense'))).toHaveLength(1);
    expect(settleToggles(tree)).toHaveLength(2);
    expect(allByName(tree, t('expenses.delete'))).toHaveLength(1);
  });

  it('removes a split with the Trash, asking for that split within the family', async () => {
    as('m-parent');
    vi.stubGlobal('confirm', () => true);
    const tree = mounted();
    await settle();

    await click(byName(tree, t('expenses.delete')));

    expect(db.table('expense_splits').map((row) => row.id)).toEqual([]);
    expect(h.toasts.success).toContain(t('expensesModule.deleted'));
    const removal = sent.find((q) => q.table === 'expense_splits' && q.calls.some((c) => c.method === 'delete'));
    expect(removal?.calls.filter((c) => c.method === 'eq').map((c) => c.args)).toEqual([['id', 'split-1'], ['family_id', FAMILY]]);
    expect(removal?.calls.some((c) => c.method === 'select')).toBe(true);
  });
});
