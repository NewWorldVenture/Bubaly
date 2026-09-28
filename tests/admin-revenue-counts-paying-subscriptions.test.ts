import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { subscriptionRevenue } from '@/lib/admin/subscription-revenue';
import { BASIC_MONTHLY_CENTS, PLUS_MONTHLY_CENTS } from '@/lib/constants/plans';

// METRIC-002. /admin/billing counted `trialing` subscriptions as active and as
// revenue ("Est. MRR"), while /admin/reports counted `active` alone, so the two
// pages disagreed on "Active Subscriptions" and on monthly revenue for the same
// families. Found by the integrated retest of MAIN-F-J05/J06 (2026-09-28): over
// 1,214 seeded families, reports said 1,201 active and billing 1,207. A trial
// has not paid, and Stripe's own MRR leaves trials out.

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

  it('both admin pages take their revenue from the one definition', () => {
    for (const page of ['app/(app)/admin/billing/page.tsx', 'app/(app)/admin/reports/page.tsx']) {
      const src = code(page);
      expect(src, page).toMatch(/subscriptionRevenue\(/);
      expect(src, page).not.toMatch(/status === 'trialing'\)/);
      expect(src, page).not.toMatch(/const mrrCents = [^;]*\.reduce\(/);
    }
  });

  it('billing still shows the trials, beside the paying count', () => {
    expect(code('app/(app)/admin/billing/page.tsx')).toMatch(/trialing\.length/);
  });
});
