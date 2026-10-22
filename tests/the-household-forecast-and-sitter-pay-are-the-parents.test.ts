// M7 and M8 — two money screens shown to every member are a parent's or adult's.
//
// lib/finance/household-money.ts records the owner's decision (the held 0514):
// the household's accounts and balances, and the babysitter payouts, are a
// parent's or adult's, and the screens show the same thing before and after
// 0514 is released.
//
//   M7  /dashboard/money-timeline summed the family's checking and savings into
//       "Liquid today" and projected the household's low from it for any
//       non-guest: a child, a teen or a caregiver opening it read the
//       household balance. Family CFO and billing already refuse it.
//   M8  /wallet/babysitters read every sitter's payments (amount, tip, hours,
//       rate) for any non-guest, and rendered them with a "Total Paid": a teen
//       or a caregiver who is one of the sitters read everyone's pay.
//
// Both pages are rendered for real, against an in-memory database, the way a
// phone would paint them.
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import type { CashflowTimeline } from '@/lib/finance/timeline';

const FAMILY = 'family-1';
const harness = vi.hoisted(() => ({ db: null as unknown, role: 'parent', load: vi.fn() }));

vi.mock('next/navigation', () => ({
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); },
  useRouter: () => ({ refresh: () => {} }),
}));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: `user-${harness.role}` },
    memberships: [],
    active: { familyId: 'family-1', role: harness.role, member: { id: `member-${harness.role}` }, family: { id: 'family-1', timezone: 'UTC' } },
  }),
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db }));
// Step-up answers "allow": it is not a role gate (needsStepUp is false for a non-manager).
vi.mock('@/lib/auth/require-aal2', () => ({ requireAal2: async () => {} }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return {
    getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params),
    getLocaleContext: async () => ({ locale: { code: 'en-US' } }),
  };
});
vi.mock('@/lib/finance/timeline-load', () => ({ loadMoneyTimeline: harness.load }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: () => {}, error: () => {} }) }));
vi.mock('@/components/i18n/locale-provider', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return {
    useTranslations: () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params),
    useLocale: () => ({ code: 'en-US' }),
    useFamilyTimeZone: () => 'UTC',
  };
});
vi.mock('@/components/wallet/wallet-subnav', () => ({ WalletSubnav: () => null }));

const { default: MoneyTimelinePage } = await import('@/app/(app)/dashboard/money-timeline/page');
const { default: WalletBabysittersPage } = await import('@/app/(app)/wallet/babysitters/page');
const { BabysittersView } = await import('@/components/wallet/babysitters-view');
const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
const t = (key: string) => translate(SOURCE_MESSAGES, key);

let db: InMemorySupabase;

/** The household's forecast: $6,840 in checking and savings, a low of $1,212. */
const FORECAST: CashflowTimeline = {
  weeks: [{ weekStart: '2026-10-11', outflow: 820, moments: [], events: [], projectedBalance: 1212, heavy: false }],
  startingBalance: 6840, totalOutflow: 820, monthlyRecurring: 310, heaviestWeek: null,
  lowestBalance: 1212, lowestBalanceWeek: '2026-10-11', insights: [], planOutflow: 0, scenarioOutflow: 0,
  coverage: { coveredCount: 0, coveredAmount: 0, openCount: 0, openAmount: 0, paidCount: 0, paidAmount: 0, coveredBills: 0, paidBills: 0, openBills: 0, totalBills: 0 },
};

const paint = (tree: unknown) => renderToStaticMarkup(tree as ReactElement).replace(/&#x27;|&#39;/g, "'");

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase();
  harness.db = db;
  harness.role = 'parent';
  harness.load.mockReset().mockResolvedValue(FORECAST);
});

describe('M7 — the money timeline is a parent\'s or adult\'s', () => {
  it('a parent reads Liquid today and the projected low (the control)', async () => {
    const html = paint(await MoneyTimelinePage());
    expect(html).toContain(t('moneyTimeline.liquidToday'));
    expect(html).toContain('$6,840');
  });

  it.each(['child', 'teen', 'caregiver'])('a %s is told whose the money is, and the forecast is never built', async (role) => {
    harness.role = role;
    const html = paint(await MoneyTimelinePage());
    expect(html).toContain(t('householdMoney.keptByParents'));
    expect(html).not.toContain(t('moneyTimeline.liquidToday'));
    expect(html).not.toContain('$6,840');
    expect(html).not.toContain('$1,212');
    expect(harness.load).not.toHaveBeenCalled();
  });
});

describe('M8 — the babysitter payouts are a parent\'s or adult\'s', () => {
  beforeEach(() => {
    db.seed('babysitter_profiles', [{ id: 'sitter-1', family_id: FAMILY, name: 'Sam Sitter', phone: null, email: null, rate_cents: 2000, notes: null, is_active: true }]);
    db.seed('babysitter_payments', [
      { id: 'pay-1', family_id: FAMILY, babysitter_id: 'sitter-1', hours: 4, rate_cents: 2000, tip_cents: 1500, amount_cents: 9500, status: 'completed', created_at: '2026-10-10T20:00:00Z' },
    ]);
  });

  /** The BabysittersView element the page renders. */
  function viewOf(node: ReactNode): ReactElement<Record<string, unknown>> | null {
    if (!isValidElement<{ children?: ReactNode }>(node)) return null;
    if (node.type === BabysittersView) return node as ReactElement<Record<string, unknown>>;
    return null;
  }

  it('a parent sees what each sitter was paid (the control)', async () => {
    const view = viewOf(await WalletBabysittersPage());
    expect(view?.props.payments).toHaveLength(1);
    const html = paint(createElement(BabysittersView, view!.props as never));
    expect(html).toContain('$95');
    expect(html).toContain('Total Paid');
  });

  it.each(['teen', 'child', 'caregiver'])('a %s sees the sitters, and no payout is read or shown', async (role) => {
    harness.role = role;
    const page = await WalletBabysittersPage();
    expect(db.log.map((l) => l.table)).not.toContain('babysitter_payments');
    const view = viewOf(page);
    expect(view?.props.payments).toEqual([]);

    const html = paint(createElement(BabysittersView, view!.props as never));
    expect(html).toContain('Sam Sitter');
    expect(html).toContain(t('babysittersView.payoutsAreKeptByParents'));
    expect(html).not.toContain('$95');
    expect(html).not.toContain('Total Paid');
    expect(html).not.toContain(t('babysitters.recentPayments'));
  });
});
