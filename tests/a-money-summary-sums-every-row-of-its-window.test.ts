// SUMMED-READ-SIB — two more money summaries are the sum of every row in their
// window, or an error, never the sum of what one capped request returned.
//
//   Home's Family Finances card read `.gte('date', monthStart).limit(1000)`:
//   no end, so next month's scheduled rows took places in the read, and
//   PostgREST's 1,000-row cap, so a busy month was summed from part of it. It
//   also kept the rows of Greenwich's month, which on a month's last evening
//   in Los Angeles is already next month.
//
//   The intelligence preview's weekly-spend band summed one unpaged request
//   over 28 days: past 1,000 expenses, the household was banded on part of
//   its spending, and offered to share that band.
//
// (The default Finances view, the third sibling, is driven in
// tests/money-screens-add-up-every-row-in-its-period.test.ts.)
//
// Both pages are rendered for real against an in-memory database capped at
// PostgREST's db-max-rows, and the figures read off the tree they return.
import { createElement, isValidElement, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES, translate } from '@/lib/i18n/messages';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY = 'ours';
const holder = vi.hoisted(() => ({ db: null as unknown, tz: 'UTC' }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => holder.db, createServiceClient: () => holder.db }));
vi.mock('@/lib/supabase/auth', () => {
  const ctx = () => ({
    user: { id: 'me' },
    active: { familyId: 'ours', role: 'parent', member: { id: 'member', role: 'parent', display_name: 'Sam', user_id: 'me' }, family: { id: 'ours', timezone: holder.tz } },
  });
  return { requireUserContext: async () => ctx(), requireFeature: async () => ctx() };
});
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES: messages, translate: tr, getMessages } = await import('@/lib/i18n/messages');
  const { DEFAULT_LOCALE, localeOrDefault } = await import('@/lib/i18n/locales');
  return {
    getTranslations: async () => (key: string, params?: Record<string, string | number>) => tr(messages, key, params),
    getLocaleContext: async () => ({ locale: localeOrDefault(DEFAULT_LOCALE), source: 'default', messages: getMessages(DEFAULT_LOCALE) }),
  };
});
// Home's other sources, as tests/outcome-discovery-sources.test.ts stubs them.
vi.mock('@/lib/home/completed', () => ({ loadCompletedByBubaly: async () => ({ ok: true, data: [] }) }));
vi.mock('@/lib/services/approvals', () => ({ listPending: async () => ({ ok: true, data: [] }) }));
vi.mock('@/lib/schedule/intelligence-server', () => ({ loadScheduleIntelligence: async () => ({ ok: true, data: { byEvent: {} } }) }));
vi.mock('@/lib/metric/time-saved-server', () => ({ loadTimeSaved: async () => ({ show: false }) }));
vi.mock('@/lib/operating-index/server', () => ({ loadOperatingIndex: async () => ({ change: null }) }));
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: ComponentProps<'a'>) => createElement('a', { href, ...props }, children),
}));
vi.mock('@/components/dashboard/dashboard-weather', () => ({ DashboardWeather: () => null }));
vi.mock('@/components/ui/avatar', () => ({ Avatar: () => null }));
// The intelligence page's reads beside the preview, none of them money (the
// k-floor re-check of its cohort's aggregates is one of them).
vi.mock('@/lib/metric/automatic-capture-server', () => ({ loadAutomaticCaptureShare: async () => ({ ok: true, data: null }) }));
vi.mock('@/lib/network/benchmarks-server', () => ({
  benchmarksPageIsPublished: async () => false,
  readTrueCohortSizes: async () => ({ ok: true, sizes: new Map() }),
}));

const { default: Home } = await import('@/app/(app)/home/page');
const { default: IntelligencePage } = await import('@/app/(app)/dashboard/intelligence/page');
const { IntelligenceModule } = await import('@/components/modules/intelligence-module');

const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);

/** Every element in a server tree, walked through children without rendering any component. */
function elements(node: ReactNode, out: ReactElement<Record<string, unknown>>[] = []): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) { for (const child of node) elements(child, out); return out; }
  if (!isValidElement<Record<string, unknown>>(node)) return out;
  out.push(node);
  elements(node.props.children as ReactNode, out);
  return out;
}

/** The Family Finances card's figure for a label, as its Row shows it. */
function figure(tree: ReactNode, labelKey: string): string | undefined {
  return elements(tree).find((e) => e.props.label === t(labelKey) && typeof e.props.value === 'string')?.props.value as string | undefined;
}

let db: InMemorySupabase;
let seq = 0;
const txn = (date: string, amount: number, type = 'expense', status = 'posted') => ({
  id: `t-${String(++seq).padStart(6, '0')}`, family_id: FAMILY, name: 'Shop', merchant: null, amount, category: 'Groceries', date, type, status, member_id: null,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-13T12:00:00Z'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase({ maxRows: 1000 });
  holder.db = db;
  holder.tz = 'UTC';
  seq = 0;
  db.seed('families', [{ id: FAMILY, timezone: 'UTC' }]);
  db.seed('family_members', [{ id: 'member', family_id: FAMILY, display_name: 'Sam', role: 'parent', is_active: true, user_id: 'me' }]);
  db.seed('activation_events', [{ id: 'activated', family_id: FAMILY, user_id: 'me', milestone: 'first_outcome_viewed' }]);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('Home\'s Family Finances card sums the family\'s whole month', () => {
  it('past 1,000 rows, and with next month\'s scheduled rows, it is every row of this month and none of next', async () => {
    // Next month's rent, recorded today as scheduled, then 1,200 October shops of $1.
    db.seed('transactions', Array.from({ length: 30 }, () => txn('2026-11-01', 100, 'expense', 'scheduled')));
    db.seed('transactions', Array.from({ length: 1200 }, (_, i) => txn(`2026-10-${String(1 + (i % 13)).padStart(2, '0')}`, 1)));
    db.seed('transactions', [txn('2026-10-01', 2000, 'income')]);

    const tree = await Home();
    expect(figure(tree, 'home.totalExpenses')).toBe('$1,200.00');
    expect(figure(tree, 'home.totalIncome')).toBe('$2,000.00');
    expect(figure(tree, 'home.remaining')).toBe('$800.00');
  });

  it('on the month\'s last evening in Los Angeles, it is still that month\'s figures', async () => {
    holder.tz = 'America/Los_Angeles';
    vi.setSystemTime(new Date('2026-11-01T00:30:00Z')); // 17:30 PDT, 31 October
    db.seed('transactions', [txn('2026-10-05', 100), txn('2026-10-31', 40)]);

    expect(figure(await Home(), 'home.totalExpenses')).toBe('$140.00');
  });

  it('a month past the read\'s ceiling is an error on the card, not a smaller total', async () => {
    db.seed('transactions', Array.from({ length: 50_001 }, () => txn('2026-10-05', 1)));

    const tree = await Home();
    expect(figure(tree, 'home.totalExpenses')).toBeUndefined();
    expect(elements(tree).some((e) => e.props.role === 'alert' && e.props.children === t('financesModule.couldNotLoadFinancialData'))).toBe(true);
  });
});

describe('the intelligence preview bands every expense of its 28 days', () => {
  /** The weekly-spend band the preview would contribute. */
  async function spendBand(): Promise<string | undefined> {
    const preview = elements(await IntelligencePage()).find((e) => e.type === IntelligenceModule);
    if (!preview) throw new Error('no preview rendered');
    const buckets = preview.props.contribution as { labelKey: string; value: string }[];
    return buckets.find((b) => b.labelKey === 'network.bucketWeeklySpend')?.value;
  }

  it('2,000 one-dollar expenses over four weeks are $500 a week, not the $250 of one capped page', async () => {
    db.seed('transactions', Array.from({ length: 2000 }, (_, i) => txn(`2026-10-${String(1 + (i % 12)).padStart(2, '0')}`, 1)));
    expect(await spendBand()).toBe('500–1,000');
  });

  it('a window past the read\'s ceiling is the preview\'s error, not a smaller band', async () => {
    db.seed('transactions', Array.from({ length: 50_001 }, () => txn('2026-10-05', 1)));
    const page = await IntelligencePage();
    expect(elements(page).some((e) => e.type === IntelligenceModule)).toBe(false);
    const shown = await (page.type as () => Promise<ReactNode>)();
    expect(elements(shown).some((e) => e.props.message === t('intelligence.couldNotLoadContributionPreview'))).toBe(true);
  });
});
