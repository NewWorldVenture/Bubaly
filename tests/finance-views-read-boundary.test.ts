// A failed read is not an empty balance sheet.
//
// Four money pages each dropped the read error from useRealtimeQuery and
// rendered their empty state instead: "No bills yet", "No budgets yet",
// "No payments", "No savings goals" — and, on Payments, four summary tiles
// reading +$0.00, -$0.00, +$0.00 and 0 transactions. Every one of those is a
// statement about a family's money, and none of them was true: the query had
// failed, so the page knew nothing at all. A parent reads "No bills" and stops
// looking, and the bill they were owed a reminder about is the one they miss.
//
// These tests render the real components — no source grepping — with the query
// hook in each of its three states, and assert the page says what it actually
// knows.
import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';

const MESSAGES = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;

type QueryState = { data: unknown[]; loading: boolean; error: string | null };
const state = vi.hoisted(() => ({ current: { data: [], loading: false, error: null } as QueryState }));
const refreshes = vi.hoisted(() => ({ count: 0 }));

vi.mock('@/components/app/app-context', () => ({
  useApp: () => ({ familyId: 'fam-1', userId: 'user-1' }),
}));
vi.mock('@/lib/hooks/use-realtime-query', () => ({
  useRealtimeQuery: () => ({
    ...state.current,
    refresh: () => { refreshes.count += 1; },
    setData: () => {},
  }),
}));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({}) }));
vi.mock('@/components/ui/toast', () => ({
  useToast: () => ({ success: () => {}, error: () => {}, info: () => {}, show: () => {} }),
}));
vi.mock('@/components/i18n/locale-provider', () => ({
  useTranslations: () => (key: string) => MESSAGES[key] ?? key,
  useLocale: () => 'en-US',
}));
// ErrorState, but able to pull the trigger on the handler it was handed.
const probeRetry = vi.hoisted(() => ({ on: false }));
vi.mock('@/components/ui/states', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/states')>();
  return {
    ...actual,
    ErrorState: ({ message, onRetry }: { message: string; onRetry?: () => void }) => {
      if (probeRetry.on) onRetry?.();
      return actual.ErrorState({ message, onRetry });
    },
  };
});
vi.mock('@/app/(app)/dashboard/billing/actions', () => ({
  deleteBudgetAction: async () => ({ ok: true }),
  setBudgetAction: async () => ({ ok: true }),
  contributeToGoalAction: async () => ({ ok: true }),
  createSavingsGoalAction: async () => ({ ok: true }),
  deleteSavingsGoalAction: async () => ({ ok: true }),
}));

const { BillsView } = await import('@/components/finance/bills-view');
const { BudgetsView } = await import('@/components/finance/budgets-view');
const { PaymentsView } = await import('@/components/finance/payments-view');
const { SavingsView } = await import('@/components/finance/savings-view');

function render(element: React.ReactElement, next: QueryState) {
  state.current = next;
  return renderToStaticMarkup(element);
}

const VIEWS = [
  {
    name: 'Bills',
    element: React.createElement(BillsView, { mode: 'all' as const }),
    errorKey: 'billsView.couldNotLoadBills',
    english: 'Could not load bills. Refresh and try again.',
    // Not a catalogue key: this page still hardcodes its empty-state titles.
    empty: 'No bills yet',
  },
  {
    name: 'Budgets',
    element: React.createElement(BudgetsView),
    errorKey: 'budgetsView.couldNotLoadBudgets',
    english: 'Could not load budgets. Refresh and try again.',
    emptyKey: 'budgets.noBudgetsYet',
  },
  {
    name: 'Payments',
    element: React.createElement(PaymentsView),
    errorKey: 'paymentsView.couldNotLoadPayments',
    english: 'Could not load payments. Refresh and try again.',
    emptyKey: 'payments.noPayments',
  },
  {
    name: 'Savings',
    element: React.createElement(SavingsView),
    errorKey: 'savingsView.couldNotLoadSavingsGoals',
    english: 'Could not load savings goals. Refresh and try again.',
    emptyKey: 'savings.noSavingsGoals',
  },
];

/** The empty-state wording, from the catalogue where the page uses one. */
function emptyText(view: { emptyKey?: string; empty?: string }): string {
  if (view.empty) return view.empty;
  const text = MESSAGES[view.emptyKey as string];
  expect(text, `${view.emptyKey} is missing from the catalogue`).toBeTruthy();
  return text;
}

describe('a money page tells a failed read apart from an empty one', () => {
  it.each(VIEWS)('$name says so when the read fails', ({ element, errorKey, english }) => {
    // Two halves, because either alone can pass on a broken page: the catalogue
    // must still say this in English, and the page must actually render it.
    expect(MESSAGES[errorKey], `${errorKey} should still say "${english}"`).toBe(english);
    const html = render(element, { data: [], loading: false, error: 'network down' });
    expect(html, `${errorKey} never reached the page`).toContain(english);
    expect(html, 'a failed read must offer a way back').toContain('Try again');
  });

  it.each(VIEWS)('$name does not claim emptiness when the read failed', (view) => {
    const { element } = view;
    const empty = emptyText(view);
    const failed = render(element, { data: [], loading: false, error: 'network down' });
    expect(failed, `"${empty}" is a claim the page cannot support`).not.toContain(empty);
  });

  it.each(VIEWS)('$name still shows its empty state on a successful empty read', (view) => {
    const { element, english } = view;
    const html = render(element, { data: [], loading: false, error: null });
    expect(html, 'a genuinely empty list must still say so').toContain(emptyText(view));
    expect(html, 'nothing failed, so nothing should be reported as failed').not.toContain(english);
  });

  it.each(VIEWS)('$name shows neither state while the first read is still running', (view) => {
    const { element, english } = view;
    const html = render(element, { data: [], loading: true, error: null });
    expect(html).not.toContain(emptyText(view));
    expect(html).not.toContain(english);
  });
});

describe('the Payments summary states a figure only once it has one', () => {
  const totals = ['+$0.00', '-$0.00'];

  it('shows no dollar figure while the first read is running', () => {
    const html = render(React.createElement(PaymentsView), { data: [], loading: true, error: null });
    for (const total of totals) {
      expect(html, `${total} is a claim about this family's money, and the read has not come back`)
        .not.toContain(total);
    }
  });

  it('shows no dollar figure when the read failed', () => {
    const html = render(React.createElement(PaymentsView), { data: [], loading: false, error: 'network down' });
    for (const total of totals) expect(html, `${total} was never read`).not.toContain(total);
  });

  it('shows the real zero once an empty read succeeds', () => {
    // The distinction only means something if a true zero still renders.
    const html = render(React.createElement(PaymentsView), { data: [], loading: false, error: null });
    expect(html).toContain('+$0.00');
    expect(html).toContain('-$0.00');
  });
});

describe('the retry actually re-runs the read', () => {
  // "Try again" wired to nothing looks identical in the rendered HTML, so the
  // stand-in ErrorState calls the handler it was given and the count says
  // whether that reached refresh().
  it.each(VIEWS)('$name hands ErrorState a retry that calls refresh', ({ element }) => {
    probeRetry.on = true;
    const before = refreshes.count;
    try {
      render(element, { data: [], loading: false, error: 'network down' });
    } finally {
      probeRetry.on = false;
    }
    expect(refreshes.count, 'the retry did not reach the query hook').toBeGreaterThan(before);
  });
});
