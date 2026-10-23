import { readFileSync } from 'node:fs';
import type { ComponentProps } from 'react';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { subscriptionRevenue, subscriptionsIn } from '@/lib/admin/subscription-revenue';
import { BASIC_MONTHLY_CENTS, PLUS_ANNUAL_CENTS, PLUS_MONTHLY_CENTS } from '@/lib/constants/plans';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { fmtMoney } from '@/lib/utils/format';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { renderServerPage, statCardValue } from './helpers/render-server-page';

// METRIC-002. /admin/billing counted `trialing` subscriptions as active and as
// revenue ("Est. MRR"), while /admin/reports counted `active` alone, so the two
// pages disagreed on "Active Subscriptions" and on monthly revenue for the same
// families. Found by the integrated retest of MAIN-F-J05/J06 (2026-09-28): over
// 1,214 seeded families, reports said 1,201 active and billing 1,207. A trial
// has not paid, and Stripe's own MRR leaves trials out.

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => h.db,
  describeConfiguredServiceKey: () => null,
}));
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params),
  getLocaleContext: async () => ({ locale: { code: 'en-US' } }),
}));
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: ComponentProps<'a'>) => createElement('a', { href, ...props }, children),
}));

const code = (path: string) =>
  readFileSync(path, 'utf8').split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');

describe('admin revenue counts paying subscriptions only', () => {
  const rows = [
    { plan: 'basic', status: 'active' },
    { plan: 'plus', status: 'active' },
    { plan: 'plus', status: 'trialing' },
    { plan: 'plus', status: 'past_due' },
    { plan: 'basic', status: 'unpaid' },
    { plan: 'basic', status: 'canceled' },
    { plan: 'free', status: null },
  ];

  it('a trial is counted, but not as revenue', () => {
    const r = subscriptionRevenue(rows);
    expect(r.paying).toHaveLength(2);
    expect(r.trialing).toHaveLength(1);
    expect(r.pastDue).toHaveLength(2);
    expect(r.mrrCents).toBe(BASIC_MONTHLY_CENTS + PLUS_MONTHLY_CENTS);
  });

  it('a tally — a count of the subscriptions sharing a plan and status — is sorted and priced by the same definition', () => {
    const r = subscriptionRevenue([
      { plan: 'basic', status: 'active', count: 4 },
      { plan: 'plus_annual', status: 'active', count: 3 },
      { plan: null, status: 'active', count: 2 },
      { plan: null, status: 'trialing', count: 5 },
      { plan: null, status: 'past_due', count: 1 },
      { plan: null, status: 'unpaid', count: 6 },
      { plan: null, status: 'canceled', count: 9 },
    ]);
    expect(subscriptionsIn(r.paying)).toBe(9);
    expect(subscriptionsIn(r.trialing)).toBe(5);
    expect(subscriptionsIn(r.pastDue)).toBe(7);
    expect(r.mrrCents).toBe(4 * BASIC_MONTHLY_CENTS + 3 * Math.round(PLUS_ANNUAL_CENTS / 12));
    // A row read from the table stands for one subscription.
    expect(subscriptionsIn(subscriptionRevenue(rows).paying)).toBe(2);
  });

  it('both admin pages take their revenue from the one definition', () => {
    for (const page of ['app/(app)/admin/billing/page.tsx', 'app/(app)/admin/reports/page.tsx']) {
      const src = code(page);
      expect(src, page).toMatch(/subscriptionRevenue\(/);
      expect(src, page).not.toMatch(/status === 'trialing'\)/);
      expect(src, page).not.toMatch(/const mrrCents = [^;]*\.reduce\(/);
    }
  });

  // Drives the real page: its figures are counts now, not rows, so the trials
  // are counted by the database and sorted by the definition above
  // (review R6-BILLING-CEILING-STILL-WHOLE-PAGE).
  it('billing still shows the trials, beside the paying count', async () => {
    const db = createInMemorySupabase({ maxRows: 1000 });
    h.db = db;
    // The table's status is NOT NULL (0002_tables.sql), so the null row stays out.
    db.seed('subscriptions', rows.filter((s) => s.status !== null).map((s, i) => ({
      id: `sub-${i}`, family_id: `fam-${i}`, ...s, created_at: '2025-01-01T00:00:00Z', current_period_end: null,
    })));
    db.seed('billing_customers', []);
    const { default: AdminBillingPage } = await import('@/app/(app)/admin/billing/page');
    const html = await renderServerPage(await AdminBillingPage());
    expect(statCardValue(html, 'Active Subscriptions')).toBe('2');
    expect(html).toContain('+ 1 trialing');
    expect(statCardValue(html, 'Est. MRR')).toBe(fmtMoney(BASIC_MONTHLY_CENTS + PLUS_MONTHLY_CENTS));
    expect(statCardValue(html, 'Past Due / Unpaid')).toBe('2');
  });
});
