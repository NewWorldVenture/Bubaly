// M12 and M13 — a month's budget figures are the month's.
//
//   M12  budgetVsActual added every line's raw limit and spent into
//        totalLimit/totalSpent whatever its period: $150 weekly Groceries +
//        $300 monthly Dining + $6,000 yearly Travel was a $6,450 limit set
//        against a week, a month and a year of spending together, and the
//        assistant was told "Budgets this month: $X of $6,450 spent".
//   M13  Family CFO's "Spending vs budget" set this month's spending against
//        each budget's raw amount whatever its period, kept whichever duplicate
//        row came last, and matched categories exactly, so an AI-recorded
//        "groceries" row had no budget beside "Groceries".
//
// The service, the assistant's money slice and the CFO page are driven for
// real against an in-memory database.
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY = 'family-1';
const harness = vi.hoisted(() => ({ db: null as unknown }));

vi.mock('next/navigation', () => ({ redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); }, notFound: () => { throw new Error('NOT_FOUND'); } }));
vi.mock('@/lib/supabase/auth', () => ({
  requireFeature: async () => ({
    user: { id: 'user-parent' },
    memberships: [],
    active: { familyId: 'family-1', role: 'parent', member: { id: 'member-parent' }, family: { id: 'family-1', timezone: 'UTC' } },
  }),
}));
vi.mock('@/lib/auth/require-aal2', () => ({ requireAal2: async () => {} }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  const { localeOrDefault } = await import('@/lib/i18n/locales');
  return {
    getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params),
    getLocaleContext: async () => ({ locale: localeOrDefault('en-US'), source: 'default', messages: SOURCE_MESSAGES }),
  };
});
// The 12-week forecast reads its own tables and is not what this card shows.
vi.mock('@/lib/finance/timeline-load', () => ({
  loadMoneyTimelineInput: async () => ({ bills: [], goals: [], events: [], startingBalance: 0 }),
}));
vi.mock('@/components/modules/handle-it-button', () => ({ HandleItButton: () => null }));
vi.mock('@/components/finance/affordability-scenario', () => ({ AffordabilityScenario: () => null }));

const { budgetVsActual } = await import('@/lib/services/finances');
const { moneySlice } = await import('@/lib/ai/context/slices/money');
const { default: FamilyCfoPage } = await import('@/app/(app)/dashboard/family-cfo/page');

let db: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;
const NOW = new Date('2026-10-13T12:00:00Z');
const scope = (): ServiceScope => ({
  db, familyId: FAMILY, userId: 'user-parent', memberId: 'member-parent',
  role: 'parent', actorKind: 'member', tz: 'UTC', now: NOW,
});

let seq = 0;
const expense = (date: string, amount: number, category: string) =>
  ({ id: `t-${String(++seq).padStart(4, '0')}`, family_id: FAMILY, name: category, amount, category, date, type: 'expense', status: 'posted', member_id: null });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase<SupabaseClient<Database>>();
  harness.db = db;
  seq = 0;
});

describe('M12 — the budget totals are this month\'s', () => {
  beforeEach(() => {
    db.seed('budgets', [
      { id: 'b-1', family_id: FAMILY, category: 'Groceries', amount: 150, period: 'weekly', created_at: '2026-01-01T00:00:00Z' },
      { id: 'b-2', family_id: FAMILY, category: 'Dining', amount: 300, period: 'monthly', created_at: '2026-01-01T00:00:00Z' },
      { id: 'b-3', family_id: FAMILY, category: 'Travel', amount: 6000, period: 'yearly', created_at: '2026-01-01T00:00:00Z' },
    ]);
    db.seed('transactions', [
      expense('2026-10-02', 200, 'Groceries'),
      expense('2026-10-12', 100, 'Groceries'),
      expense('2026-10-05', 250, 'Dining'),
      expense('2026-03-10', 1000, 'Travel'),
    ]);
  });

  it('every limit counts as its monthly share, against what was spent this month', async () => {
    const res = await budgetVsActual(scope());
    expect(res.ok, res.ok ? '' : res.error).toBe(true);
    if (!res.ok) return;
    // $150 x 52 / 12 + $300 + $6,000 / 12, not $6,450.
    expect(res.data.totalLimit).toBe(1450);
    // October's spending in the budgeted categories, not a week + a month + a year.
    expect(res.data.totalSpent).toBe(550);
    // Each line keeps its own period.
    expect(res.data.budgets.find((b) => b.category === 'Travel')).toMatchObject({ period: 'yearly', limit: 6000, spent: 1000 });
    expect(res.data.budgets.find((b) => b.category === 'Groceries')).toMatchObject({ period: 'weekly', limit: 150, spent: 100 });
  });

  it('the assistant is told this month\'s figures, and that they are monthly shares', async () => {
    const res = await moneySlice.load(scope(), { now: NOW, tz: 'UTC', todayKey: '2026-10-13' } as never);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const header = res.data.lines.find((l) => l.startsWith('- Budgets this month'));
    expect(header).toContain('$550');
    expect(header).toContain('$1,450');
    expect(header).toContain('monthly share');
    expect(header).not.toContain('$6,450');
  });
});

describe('M13 — Family CFO sets this month\'s spending against each budget\'s month', () => {
  it('a weekly budget is its monthly share, the canonical row is the one shown, and "groceries" is Groceries', async () => {
    db.seed('budgets', [
      // The budget the parent edits (the oldest row, as the finance service reads it)…
      { id: 'b-1', family_id: FAMILY, category: 'Groceries', amount: 100, period: 'weekly', created_at: '2026-01-01T00:00:00Z' },
      // …and a legacy duplicate with a later id, which the Map used to keep.
      { id: 'b-2', family_id: FAMILY, category: 'Groceries', amount: 900, period: 'monthly', created_at: '2026-05-01T00:00:00Z' },
    ]);
    db.seed('transactions', [
      expense('2026-10-03', 200, 'Groceries'),
      // Recorded by the assistant, spelled as it was said.
      expense('2026-10-08', 100, 'groceries'),
    ]);

    const html = renderToStaticMarkup(await FamilyCfoPage() as ReactElement);
    // $300 of groceries against $100 a week = $433.33 a month.
    expect(html).toContain('$300.00 / $433.33');
    expect(html).not.toContain('$900.00');
    expect(html).not.toContain('$200.00');
  });
});
