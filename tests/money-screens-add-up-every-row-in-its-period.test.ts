import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { byName, click, has, nodes, render, text } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

// The money screens, driven as a family opens them: the REAL component, its
// own reads run against an in-memory database capped at PostgREST's
// db-max-rows (1,000), and the figures it puts on the screen.
//
//   M3/M5  Budget Planner   one unpaged, unordered transactions read: past 1,000
//                           rows a year each budget summed whatever slice came
//                           back, and the page said "$X left" to a family over
//                           budget. It also read from 1 January, so a weekly
//                           budget lost the December days of its first week.
//   M14    Budget Planner   only the period's START was checked: next month's
//          and Finances     scheduled rent counted in this month.
//   M4     Expenses         splits and shares read unpaged: past 1,000 share
//                           rows "Settle up" and "Outstanding" were built on
//                           part of the ledger.
//   M12    Finances         weekly, monthly and yearly limits added raw and set
//                           against a month of spending: one yearly budget read
//                           an overspent month as on track.
//   M15    Finances, Wallet a credit account's balance (money owed) was added
//          and Billing      to "Total balance" as cash.
//   M13    Billing manage   each budget's raw amount, whatever its period, was
//                           set against a calendar month of spend from a
//                           capped read, matched case-sensitively, with every
//                           duplicate budget row its own line.
//   M13-SIB Finances        the month was summed from the newest-500 list, and
//                           every duplicate budget row's limit was in the bar:
//                           the default view disagreed with ?view=manage.
//   SUMMED-READ-SIB-PAYMENTS
//          Payments         the same newest-500 list was the "this month" tiles
//                           on /dashboard/payments, next month's scheduled rows
//                           first in it.

type Fetcher = (client: unknown) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
const live = vi.hoisted(() => ({
  queries: new Map<string, { fetcher: Fetcher; data: unknown[]; error: string | null; loaded: boolean }>(),
}));

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/lib/hooks/use-realtime-query', async () => {
  const { clientFor } = await import('./helpers/module-harness');
  return {
    useRealtimeQuery: ({ table, deps, fetcher }: { table: string; deps?: unknown[]; fetcher: Fetcher }) => {
      const key = `${table}|${JSON.stringify(deps ?? [])}`;
      let query = live.queries.get(key);
      if (!query) { query = { fetcher, data: [], error: null, loaded: false }; live.queries.set(key, query); }
      query.fetcher = fetcher;
      const entry = query;
      const reread = async () => {
        const { data, error } = await entry.fetcher(clientFor(h));
        entry.loaded = true;
        entry.error = error ? error.message : null;
        if (!error) entry.data = data ?? [];
        return !error;
      };
      return {
        data: entry.data, loading: !entry.loaded, error: entry.error, stale: false, updatedAt: 0,
        refresh: async () => { await reread(); },
        refreshAndConfirm: async () => ((await reread()) ? { ok: true as const } : { ok: false as const, reason: 'error' as const }),
        setData: () => {},
      };
    },
  };
});
vi.mock('@/lib/supabase/client', async () => (await import('./helpers/module-harness')).supabaseClientModule(h));
vi.mock('@/components/app/app-context', async () => (await import('./helpers/module-harness')).appContextModule(h));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/ui/confirm', async () => (await import('./helpers/module-harness')).confirmModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/modal', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/input', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/states', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/avatar', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/badge', async () => (await import('./helpers/module-harness')).ui);
// One value across renders, as the real hooks keep theirs: a fresh callback on
// every render would re-run each effect keyed on it, without end.
const billing = vi.hoisted(() => ({
  search: new URLSearchParams(),
  subscription: { subscription: null, status: 'ready', reload: async () => {}, isCurrentReady: () => true },
}));
vi.mock('next/navigation', () => ({ useSearchParams: () => billing.search }));
vi.mock('@/lib/hooks/use-billing-subscription', () => ({ useBillingSubscription: () => billing.subscription }));
vi.mock('@/components/billing/family-delivered-value', () => ({ FamilyDeliveredValue: () => null }));
vi.mock('@/components/billing/family-value-comparison', () => ({ FamilyValueComparison: () => null }));
vi.mock('@/components/billing/selected-plan-review', () => ({ SelectedPlanReview: () => null }));
vi.mock('@/components/app/page-header', async () => (await import('./helpers/module-harness')).ui);
vi.mock('next/link', async () => ({ default: (await import('./helpers/module-harness')).ui.Link }));
vi.mock('@/components/ai/ai-insight', () => ({ AiInsight: () => null }));
vi.mock('@/app/(app)/dashboard/billing/actions', () => ({
  deleteBudgetAction: vi.fn(), setBudgetAction: vi.fn(), createTransactionAction: vi.fn(),
  createSavingsGoalAction: vi.fn(), deleteSavingsGoalAction: vi.fn(), deleteTransactionAction: vi.fn(),
  confirmBillScheduleAction: vi.fn(),
}));
vi.mock('@/app/(app)/wallet/hub-actions', () => ({
  addAccountAction: vi.fn(), addCardAction: vi.fn(), addPassAction: vi.fn(), addRewardAction: vi.fn(),
  addTransactionAction: vi.fn(), deleteWalletRowAction: vi.fn(),
}));

const { BudgetsView } = await import('@/components/finance/budgets-view');
const { ExpensesModule } = await import('@/components/modules/expenses-module');
const { FinancesModule } = await import('@/components/modules/finances-module');
const { WalletHub } = await import('@/components/wallet/wallet-hub');
// /dashboard/billing?view=manage
const { BillingModule } = await import('@/components/modules/billing-module');
// /dashboard/payments
const { PaymentsView } = await import('@/components/finance/payments-view');

const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
const FAMILY = h.app.familyId;
const PARENT = 'member-1';
let db: ReturnType<typeof createInMemorySupabase>;

/** Render, run every read the screen registered against the capped database, and render what came back. */
async function show(element: () => ReturnType<typeof createElement>): Promise<ReactNode> {
  for (let pass = 0; pass < 6; pass++) {
    render(h.hooks, element());
    const pending = [...live.queries.values()].filter((q) => !q.loaded);
    if (!pending.length) break;
    for (const query of pending) {
      const { data, error } = await query.fetcher((await import('./helpers/module-harness')).clientFor(h));
      query.loaded = true;
      query.error = error ? error.message : null;
      query.data = error ? [] : data ?? [];
    }
  }
  return render(h.hooks, element());
}

/** The budget card for a category: its text, from the category name to its footer. */
function budgetCard(tree: ReactNode, category: string): string {
  const card = nodes(tree).find((n) => n.type === 'div' && n.key && text(n).startsWith(category));
  if (!card) throw new Error(`no budget card for ${category}`);
  return text(card);
}

/** Open one of the billing manage view's tabs, as a click on it does, and render what it shows. */
async function billingTab(tree: ReactNode, tab: string): Promise<ReactNode> {
  await click(byName(tree, t(`billingModule.tab.${tab}`), 'button'));
  return render(h.hooks, createElement(BillingModule));
}

/** A stat tile's text, found by its label: the smallest block that holds the label and a value. */
function tile(tree: ReactNode, label: string): string {
  const found = nodes(tree).map(text).filter((s) => s.startsWith(label) && s.length > label.length);
  if (!found.length) throw new Error(`no tile labelled ${label}`);
  return found.sort((a, b) => a.length - b.length)[0];
}

let seq = 0;
const id = (prefix: string) => `${prefix}-${String(++seq).padStart(6, '0')}`;
function txn(date: string, amount: number, category: string, extra: Record<string, unknown> = {}) {
  return { id: id('t'), family_id: FAMILY, name: category, merchant: null, amount, category, date, type: 'expense', status: 'posted', member_id: null, account_id: null, notes: null, created_by: 'user-1', ...extra };
}
function budget(category: string, amount: number, period: 'weekly' | 'monthly' | 'yearly', createdAt = '2026-01-01T00:00:00Z') {
  return { id: id('b'), family_id: FAMILY, category, amount, period, created_by: 'user-1', created_at: createdAt };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-13T12:00:00Z'));
  resetHookSlots(h.hooks);
  live.queries.clear();
  seq = 0;
  // PostgREST's db-max-rows on a default Supabase project.
  db = createInMemorySupabase({ maxRows: 1000 });
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.toasts = { success: [], error: [] }; h.confirmAnswer = true; h.timeZone = 'UTC';
  h.app.members = [
    { id: PARENT, display_name: 'Ada', role: 'parent', is_active: true, color: null, birthday: null },
    { id: 'member-2', display_name: 'Bo', role: 'adult', is_active: true, color: null, birthday: null },
    { id: 'member-3', display_name: 'Cy', role: 'teen', is_active: true, color: null, birthday: null },
    { id: 'member-4', display_name: 'Di', role: 'child', is_active: true, color: null, birthday: null },
  ];
  h.app.selfMember = { ...h.app.members[0], family_id: FAMILY };
  (h.app as Record<string, unknown>).role = 'parent';
  h.app.family = { id: FAMILY, name: 'Fixture family', timezone: 'UTC' };
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('M3/M5 — the Budget Planner sums every transaction of the year', () => {
  it('a family past 1,000 transactions this year is told it is over budget, not "$300 left"', async () => {
    db.seed('budgets', [budget('Groceries', 300, 'monthly')]);
    // 1,200 older rows from earlier in the year, then October's groceries: the
    // capped, unordered read returned the first 1,000 and October fell off it.
    db.seed('transactions', Array.from({ length: 1200 }, (_, i) => txn(`2026-0${1 + (i % 9)}-15`, 5, 'Dining')));
    db.seed('transactions', Array.from({ length: 10 }, (_, i) => txn(`2026-10-${String(1 + i).padStart(2, '0')}`, 50, 'Groceries')));

    const card = budgetCard(await show(() => createElement(BudgetsView)), 'Groceries');
    expect(card).toContain('$500.00');
    expect(card).toContain('$200.00 over budget');
    expect(card).not.toContain('left');
  });

  it('a year past the read\'s ceiling is a read error, not a smaller total', async () => {
    db.seed('budgets', [budget('Groceries', 300, 'monthly')]);
    db.seed('transactions', Array.from({ length: 50_001 }, (_, i) => txn(`2026-0${1 + (i % 9)}-15`, 1, 'Dining')));

    const tree = await show(() => createElement(BudgetsView));
    expect(has(tree, t('budgetsView.couldNotLoadBudgets'))).toBe(true);
    expect(has(tree, 'left')).toBe(false);
  });

  it('a weekly budget in the first days of January counts the December days of its week', async () => {
    vi.setSystemTime(new Date('2027-01-02T12:00:00Z')); // a Saturday: the week began Sunday 27 December
    db.seed('budgets', [budget('Groceries', 100, 'weekly')]);
    db.seed('transactions', [txn('2026-12-28', 80, 'Groceries'), txn('2027-01-01', 40, 'Groceries')]);

    const card = budgetCard(await show(() => createElement(BudgetsView)), 'Groceries');
    expect(card).toContain('$120.00');
    expect(card).toContain('$20.00 over budget');
  });
});

describe('M14 — a period\'s spend stops at the end of the period', () => {
  it('next month\'s scheduled rent is not this month\'s Housing spend on the Budget Planner', async () => {
    db.seed('budgets', [budget('Housing', 2000, 'monthly')]);
    db.seed('transactions', [
      txn('2026-10-01', 1800, 'Housing'),
      txn('2026-11-01', 1800, 'Housing', { status: 'scheduled' }),
    ]);

    const card = budgetCard(await show(() => createElement(BudgetsView)), 'Housing');
    expect(card).toContain('$1,800.00');
    expect(card).toContain('$200.00 left');
    expect(card).not.toContain('over budget');
  });

  it('next month\'s scheduled rent is not in "Expenses · this month" on Finances', async () => {
    db.seed('transactions', [
      txn('2026-10-05', 100, 'Groceries'),
      txn('2026-11-01', 2000, 'Housing', { status: 'scheduled' }),
    ]);

    const expenses = tile(await show(() => createElement(FinancesModule)), t('financesModule.stat.expenses'));
    expect(expenses).toContain('$100.00');
    expect(expenses).not.toContain('$2,100.00');
  });
});

describe('M12 — the Finances budget bar is this month\'s budget', () => {
  it('one yearly budget does not make an overspent month read as on track', async () => {
    db.seed('budgets', [budget('Dining', 300, 'monthly'), budget('Travel', 6000, 'yearly')]);
    db.seed('transactions', [txn('2026-10-03', 900, 'Dining')]);

    const tree = await show(() => createElement(FinancesModule));
    // $300 a month plus $6,000 a year is $800 for the month, not $6,300.
    expect(has(tree, t('financesModule.spentOfBudget', { spent: '$900.00', budget: '$800.00' }))).toBe(true);
    expect(has(tree, t('financesModule.overBudget'))).toBe(true);
    expect(has(tree, t('financesModule.onTrack'))).toBe(false);
  });

  // M13-SIB-FIN-DUP: every budget row was summed, so a legacy duplicate's limit
  // was added to the month's budget, where the manage view, Family CFO and
  // budgetVsActual keep one budget per category, the oldest.
  it('a legacy duplicate budget is not a second limit in the month\'s budget', async () => {
    db.seed('budgets', [
      budget('Groceries', 150, 'weekly'),
      budget('Travel', 6000, 'yearly'),
      budget('Dining', 300, 'monthly'),
      budget('groceries', 999, 'monthly', '2026-06-01T00:00:00Z'),
    ]);
    db.seed('transactions', [txn('2026-10-03', 1500, 'Groceries')]);

    const tree = await show(() => createElement(FinancesModule));
    // $150 x 52/12 + $6,000 / 12 + $300 = $1,450, as the manage view's bar reads it, not $2,449.
    expect(has(tree, t('financesModule.spentOfBudget', { spent: '$1,500.00', budget: '$1,450.00' }))).toBe(true);
    expect(has(tree, '$2,449.00')).toBe(false);
    expect(has(tree, t('financesModule.overBudget'))).toBe(true);
    expect(has(tree, t('financesModule.onTrack'))).toBe(false);
  });
});

// M13-SIB-FIN-CAP: the default /dashboard/billing view summed the month from
// its newest-500 list, so it disagreed with ?view=manage past 500 rows.
describe('M13-SIB-FIN-CAP — the Finances view adds up every row of the month', () => {
  it('past 500 rows this month, "Expenses · this month" and the budget bar are all of them, as on the manage view', async () => {
    db.seed('budgets', [budget('Groceries', 1000, 'monthly')]);
    // 1,200 October shops of $1, past the newest-500 list and the server's
    // 1,000-row cap, and next month's scheduled rent, first in that list.
    db.seed('transactions', Array.from({ length: 1200 }, (_, i) => txn(`2026-10-${String(1 + (i % 13)).padStart(2, '0')}`, 1, 'Groceries')));
    db.seed('transactions', Array.from({ length: 30 }, () => txn('2026-11-01', 100, 'Housing', { status: 'scheduled' })));

    const finances = await show(() => createElement(FinancesModule));
    expect(tile(finances, t('financesModule.stat.expenses'))).toContain('$1,200.00');
    expect(has(finances, t('financesModule.spentOfBudget', { spent: '$1,200.00', budget: '$1,000.00' }))).toBe(true);
    expect(has(finances, t('financesModule.overBudget'))).toBe(true);

    // The manage view of the same page says the same.
    resetHookSlots(h.hooks);
    live.queries.clear();
    expect(tile(await show(() => createElement(BillingModule)), t('billingModule.expenses'))).toContain('$1,200.00');
  });

  it('a month past the read\'s ceiling is the error state, not a smaller total', async () => {
    db.seed('transactions', Array.from({ length: 50_001 }, () => txn('2026-10-05', 1, 'Groceries')));
    const tree = await show(() => createElement(FinancesModule));
    expect(has(tree, t('financesModule.couldNotLoadFinancialData'))).toBe(true);
    expect(has(tree, t('financesModule.stat.expenses'))).toBe(false);
  });
});

// SUMMED-READ-SIB-PAYMENTS: /dashboard/payments summed its "this month" tiles
// from its newest-500 list, ordered by date, where next month's scheduled rows
// come first: past 500 rows a month, In, Out, Net and the count were part of
// the month, while Finances, reading the month whole, said otherwise.
describe('SUMMED-READ-SIB-PAYMENTS — the Payments tiles add up every row of the month', () => {
  /** A Payments stat tile's figure, found by the label under it. */
  function figure(tree: ReactNode, label: string): string {
    const cards = nodes(tree).filter((n) => n.props.className === 'stat-card' && text(n).endsWith(label));
    if (cards.length !== 1) throw new Error(`no tile labelled ${label}`);
    const value = nodes(cards[0]).find((n) => String(n.props.className ?? '').includes('tabular-nums'));
    return text(value);
  }

  it('past 500 rows this month, In, Out, Net and the count are all of them, and next month\'s rent is in none', async () => {
    // 600 October shops of $1, past the newest-500 list; an October salary
    // older than most of them; next month's scheduled rent, first in the list.
    db.seed('transactions', Array.from({ length: 600 }, (_, i) => txn(`2026-10-${String(1 + (i % 13)).padStart(2, '0')}`, 1, 'Groceries')));
    db.seed('transactions', [txn('2026-10-01', 250, 'Salary', { type: 'income' })]);
    db.seed('transactions', Array.from({ length: 30 }, () => txn('2026-11-01', 100, 'Housing', { status: 'scheduled' })));

    const tree = await show(() => createElement(PaymentsView));
    expect(figure(tree, 'Out · this month')).toBe('-$600.00');
    expect(figure(tree, 'In · this month')).toBe('+$250.00');
    expect(figure(tree, 'Net')).toBe('-$350.00');
    expect(figure(tree, 'Transactions')).toBe('601');
  });

  it('a member who reads only their own spending is shown all of their own month, and none of the household\'s', async () => {
    (h.app as Record<string, unknown>).role = 'teen';
    h.app.selfMember = { ...h.app.members[2], family_id: FAMILY };
    db.seed('transactions', Array.from({ length: 600 }, (_, i) => txn(`2026-10-${String(1 + (i % 13)).padStart(2, '0')}`, 1, 'Snacks', { member_id: 'member-3' })));
    db.seed('transactions', Array.from({ length: 10 }, () => txn('2026-11-01', 20, 'Snacks', { member_id: 'member-3', status: 'scheduled' })));
    // The household's month, tagged to nobody and to a parent: not the teen's.
    db.seed('transactions', Array.from({ length: 200 }, (_, i) => txn('2026-10-05', 50, 'Groceries', { member_id: i % 2 ? PARENT : null })));

    const tree = await show(() => createElement(PaymentsView));
    expect(has(tree, t('householdMoney.onlyYourOwnSpending'))).toBe(true);
    expect(figure(tree, 'Out · this month')).toBe('-$600.00');
    expect(figure(tree, 'Transactions')).toBe('600');
  });

  it('a member\'s month read is narrowed to their own rows: 50,000 household rows this month leave it whole, not past its ceiling', async () => {
    (h.app as Record<string, unknown>).role = 'teen';
    h.app.selfMember = { ...h.app.members[2], family_id: FAMILY };
    db.seed('transactions', Array.from({ length: 600 }, (_, i) => txn(`2026-10-${String(1 + (i % 13)).padStart(2, '0')}`, 1, 'Snacks', { member_id: 'member-3' })));
    // Read without the member's narrowing, these push the month past MONTH_TXN_MAX.
    db.seed('transactions', Array.from({ length: 50_000 }, (_, i) => txn('2026-10-05', 1, 'Groceries', { member_id: i % 2 ? PARENT : null })));

    const tree = await show(() => createElement(PaymentsView));
    expect(has(tree, t('paymentsView.couldNotLoadPayments'))).toBe(false);
    expect(figure(tree, 'Out · this month')).toBe('-$600.00');
    expect(figure(tree, 'Transactions')).toBe('600');
  });

  /** The total in a month's heading, or null when the heading shows none. */
  function headingTotal(tree: ReactNode, month: string): string | null {
    const heading = nodes(tree).find((n) => n.type === 'h2' && text(n).startsWith(month));
    if (!heading) throw new Error(`no heading for ${month}`);
    const total = nodes(heading).find((n) => String(n.props.className ?? '').includes('tabular-nums'));
    return total ? text(total) : null;
  }

  it('this month\'s heading is the whole month, as the tiles are, not the part the newest-500 list holds', async () => {
    db.seed('transactions', Array.from({ length: 600 }, (_, i) => txn(`2026-10-${String(1 + (i % 13)).padStart(2, '0')}`, 1, 'Groceries')));
    db.seed('transactions', Array.from({ length: 30 }, () => txn('2026-11-01', 100, 'Housing', { status: 'scheduled' })));

    const tree = await show(() => createElement(PaymentsView));
    expect(headingTotal(tree, 'October 2026')).toBe('-$600.00');
    expect(headingTotal(tree, 'November 2026')).toBe('-$3,000.00');
  });

  it('a past month the full list may have cut short shows no total, rather than part of one', async () => {
    db.seed('transactions', Array.from({ length: 520 }, (_, i) => txn(`2026-09-${String(1 + (i % 28)).padStart(2, '0')}`, 1, 'Groceries')));
    db.seed('transactions', Array.from({ length: 5 }, () => txn('2026-10-05', 10, 'Groceries')));

    const tree = await show(() => createElement(PaymentsView));
    expect(headingTotal(tree, 'October 2026')).toBe('-$50.00');
    expect(headingTotal(tree, 'September 2026')).toBeNull();
  });

  it('control: a list that is not full totals every month it holds', async () => {
    db.seed('transactions', Array.from({ length: 20 }, (_, i) => txn(`2026-09-${String(1 + i).padStart(2, '0')}`, 1, 'Groceries')));
    db.seed('transactions', Array.from({ length: 5 }, () => txn('2026-10-05', 10, 'Groceries')));

    const tree = await show(() => createElement(PaymentsView));
    expect(headingTotal(tree, 'September 2026')).toBe('-$20.00');
    expect(headingTotal(tree, 'October 2026')).toBe('-$50.00');
  });

  it('a month past the read\'s ceiling is the error state, not a smaller total', async () => {
    db.seed('transactions', Array.from({ length: 50_001 }, () => txn('2026-10-05', 1, 'Groceries')));
    const tree = await show(() => createElement(PaymentsView));
    expect(has(tree, t('paymentsView.couldNotLoadPayments'))).toBe(true);
    expect(nodes(tree).some((n) => n.props.className === 'stat-card')).toBe(false);
  });
});

describe('M15 — a credit balance is owed, not cash', () => {
  beforeEach(() => {
    db.seed('financial_accounts', [
      { id: 'acct-checking', family_id: FAMILY, name: 'Checking', type: 'checking', balance: 2000, currency: 'USD', institution: null, last_four: null, created_by: 'user-1', created_at: '2026-01-01T00:00:00Z' },
      { id: 'acct-card', family_id: FAMILY, name: 'Visa', type: 'credit', balance: 1500, currency: 'USD', institution: null, last_four: null, created_by: 'user-1', created_at: '2026-01-02T00:00:00Z' },
    ]);
  });

  it('Finances\' Total Balance subtracts what is owed on the card', async () => {
    const total = tile(await show(() => createElement(FinancesModule)), t('financesModule.stat.totalBalance'));
    expect(total).toContain('$500.00');
    expect(total).not.toContain('$3,500.00');
  });

  it('the wallet\'s Total balance subtracts it too', async () => {
    const total = tile(await show(() => createElement(WalletHub)), t('wallet.totalBalance'));
    expect(total).toContain('$500.00');
    expect(total).not.toContain('$3,500.00');
  });

  it('the billing manage view subtracts it in Total Balance, under its account list and in its report', async () => {
    const overview = await show(() => createElement(BillingModule));
    const total = tile(overview, t('billingModule.totalBalance'));
    expect(total).toContain('$500.00');
    expect(total).not.toContain('$3,500.00');
    // The account list beside every tab: "Total" under Checking and Visa.
    expect(nodes(overview).map(text)).toContain(`${t('billing.total')}$500.00`);
    expect(has(overview, '$3,500.00')).toBe(false);

    const report = await billingTab(overview, 'reports');
    expect(nodes(report).map(text).filter((line) => line === `${t('billing.total')}$500.00`).length).toBeGreaterThanOrEqual(2);
    expect(has(report, '$3,500.00')).toBe(false);
  });
});

describe('M13 — the billing manage view judges each budget in its own period', () => {
  /** The budget cards on the Budgets tab (each keyed by its budget's id) whose category reads as `category`, in any case. */
  function cards(tree: ReactNode, category: string): string[] {
    return nodes(tree)
      .filter((n) => n.type === 'div' && String(n.key).startsWith('b-') && text(n).toLowerCase().startsWith(category.toLowerCase()))
      .map(text);
  }

  beforeEach(() => {
    db.seed('budgets', [
      budget('Groceries', 150, 'weekly'),
      budget('Travel', 6000, 'yearly'),
      budget('Dining', 300, 'monthly'),
      // A legacy duplicate, created later: not the budget the finance service edits.
      budget('groceries', 999, 'monthly', '2026-06-01T00:00:00Z'),
    ]);
    // 1,100 older rows, read first by id: a single capped read stops before
    // the rows below.
    db.seed('transactions', Array.from({ length: 1100 }, (_, i) => txn(`2026-0${4 + (i % 5)}-0${1 + (i % 9)}`, 1, 'Pets')));
    db.seed('transactions', [
      // Groceries: two shops earlier in October, then this week's (Sunday 11th
      // to Saturday 17th), one recorded as "groceries".
      txn('2026-10-02', 120, 'Groceries'),
      txn('2026-10-06', 130, 'Groceries'),
      txn('2026-10-12', 60, 'groceries'),
      txn('2026-10-13', 25, 'Groceries'),
      // Travel: the year's three trips.
      txn('2026-03-10', 2500, 'Travel'),
      txn('2026-07-01', 3000, 'Travel'),
      txn('2026-10-03', 800, 'Travel'),
      // Dining: this month's, and last month's, which is not this month's.
      txn('2026-10-08', 90, 'Dining'),
      txn('2026-09-28', 500, 'Dining'),
    ]);
  });

  it('a weekly budget is this week\'s spend, a yearly one the year\'s, a monthly one the month\'s', async () => {
    const budgets = await billingTab(await show(() => createElement(BillingModule)), 'budgets');

    const groceries = cards(budgets, 'Groceries');
    // One line for the category, the canonical $150 weekly budget.
    expect(groceries).toHaveLength(1);
    // This week: $60 "groceries" + $25, not October's $275 "Groceries".
    expect(groceries[0]).toContain('$85.00 / $150.00');
    expect(groceries[0]).toContain(t('billing.amountRemaining', { amount: '$65.00' }));
    expect(groceries[0]).not.toContain('$999.00');

    // The year, from March: $6,300 of $6,000, not October's $800.
    const [travel] = cards(budgets, 'Travel');
    expect(travel).toContain('$6,300.00 / $6,000.00');
    expect(travel).toContain(t('billing.overBudgetBy', { amount: '$300.00' }));

    // October's $90, not September's $500.
    const [dining] = cards(budgets, 'Dining');
    expect(dining).toContain('$90.00 / $300.00');
    expect(dining).toContain(t('billing.amountRemaining', { amount: '$210.00' }));
  });

  it('the overview\'s budget bar is this month\'s: each canonical budget as its monthly share', async () => {
    const overview = await show(() => createElement(BillingModule));
    // $150 x 52/12 + $6,000 / 12 + $300 = $1,450, the duplicate not counted;
    // against October's $1,225 of expenses.
    expect(has(overview, '$1,225.00 of $1,450.00')).toBe(true);
  });

  it('a year past the read\'s ceiling is the error state, not budgets judged on part of it', async () => {
    db.seed('transactions', Array.from({ length: 50_000 }, (_, i) => txn(`2026-0${1 + (i % 9)}-15`, 1, 'Pets')));
    const tree = await show(() => createElement(BillingModule));
    expect(nodes(tree).some((n) => n.props.role === 'alert')).toBe(true);
    expect(has(tree, t('billingModule.totalBalance'))).toBe(false);
    expect(cards(tree, 'Groceries')).toEqual([]);
  });
});

describe('M4 — Settle up and Outstanding come from every split and share', () => {
  beforeEach(() => {
    // 300 four-way splits of $40, all paid by Ada: 1,200 share rows, past the cap.
    for (let i = 0; i < 300; i++) {
      const splitId = id('s');
      db.seed('expense_splits', [{ id: splitId, family_id: FAMILY, description: `Shop ${i}`, total_cents: 4000, category: 'Groceries', paid_by: PARENT, spent_on: `2025-${String(1 + (i % 12)).padStart(2, '0')}-10`, note: null, created_by: 'user-1' }]);
      db.seed('expense_split_shares', h.app.members.map((m) => ({
        id: id('sh'), family_id: FAMILY, split_id: splitId, member_id: m.id, share_cents: 1000, settled: m.id === PARENT, settled_at: null,
      })));
    }
  });

  it('each member owes Ada for all 300 splits, and the outstanding total is all 900 open shares', async () => {
    const tree = await show(() => createElement(ExpensesModule));
    const settle = nodes(tree).filter((n) => n.type === 'li').map(text);
    expect(settle).toHaveLength(3);
    for (const name of ['Bo', 'Cy', 'Di']) {
      expect(settle.find((line) => line.includes(name)), name).toContain('$3,000.00');
    }
    expect(tile(tree, t('expenses.outstanding'))).toContain('$9,000.00');
    expect(tile(tree, t('expenses.expenses'))).toContain('300');
  });

  it('a share ledger past the ceiling is the error state, not transfers built on part of it', async () => {
    db.seed('expense_split_shares', Array.from({ length: 50_000 }, () => ({
      id: id('sh'), family_id: FAMILY, split_id: 'gone', member_id: 'member-2', share_cents: 1, settled: false, settled_at: null,
    })));
    const tree = await show(() => createElement(ExpensesModule));
    expect(has(tree, t('expensesModule.couldNotLoadSharedExpenses'))).toBe(true);
    expect(nodes(tree).some((n) => n.type === 'li')).toBe(false);
  });
});
