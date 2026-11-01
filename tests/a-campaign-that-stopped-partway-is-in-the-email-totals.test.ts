import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { createElement } from 'react';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { renderServerPage, statCardValue } from './helpers/render-server-page';

// admin-writers N4-S1. A campaign send that stops partway now records what went
// out (`recipients`) on a `failed` row, and one past the per-send cap goes back
// to `draft` with its first part delivered (lib/marketing/send.ts). The
// marketing analytics and the dashboard summed recipients, opens and clicks
// over `status === 'sent'` rows only, so mail that was delivered — and opened —
// from a campaign that was never resumed appeared in no total. The REAL pages
// against the in-memory database.

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

let db: InMemorySupabase;

beforeEach(() => {
  db = createInMemorySupabase({ maxRows: 1000 });
  h.db = db;
  for (const table of ['families', 'subscriptions', 'family_members', 'profiles', 'marketing_campaigns']) db.seed(table, []);
  db.seed('marketing_email_campaigns', [
    { id: 'mail-sent', subject: 'Sent', status: 'sent', recipients: 100, opens: 20, clicks: 4, deleted_at: null },
    // Stopped after its first batch, never resumed: 100 delivered, 30 opened.
    { id: 'mail-stopped', subject: 'Stopped', status: 'failed', recipients: 100, opens: 30, clicks: 6, deleted_at: null },
    // Past the cap: its first part went, the rest is held for the next Send.
    { id: 'mail-capped', subject: 'Capped', status: 'draft', recipients: 50, opens: 10, clicks: 0, deleted_at: null },
    // Nothing went out: nothing to count (controls).
    { id: 'mail-refused', subject: 'Refused', status: 'failed', recipients: 0, opens: 0, clicks: 0, deleted_at: null },
    { id: 'mail-draft', subject: 'Draft', status: 'draft', recipients: 0, opens: 0, clicks: 0, deleted_at: null },
  ]);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const figure = (html: string, label: string) =>
  new RegExp(`<p class="text-2xl font-bold">([^<]*)</p><p class="text-xs text-muted">${label}</p>`).exec(html)?.[1];

describe('the email totals count every delivery', () => {
  it('/admin/marketing/analytics sums recipients, opens and clicks of a stopped and a capped send', async () => {
    const { default: AnalyticsPage } = await import('@/app/(app)/admin/marketing/analytics/page');
    const html = await renderServerPage(await AnalyticsPage());
    expect(figure(html, SOURCE_MESSAGES['adminMarketingAnalytics.recipients']), 'a stopped campaign\'s deliveries were left out').toBe('250');
    expect(figure(html, SOURCE_MESSAGES['adminMarketingAnalytics.opens'])).toBe('60');
    expect(figure(html, SOURCE_MESSAGES['adminMarketingAnalytics.clicks'])).toBe('10');
    expect(html).toContain(`${SOURCE_MESSAGES['adminMarketingAnalytics.emailOpenRate']}</p><p class="text-2xl font-bold">24%</p>`);
  });

  it('/admin/marketing Email Open Rate is over every delivery', async () => {
    const { default: MarketingDashboard } = await import('@/app/(app)/admin/marketing/page');
    const html = await renderServerPage(await MarketingDashboard());
    // 60 opens of 250 delivered; the sent row alone read 20%.
    expect(statCardValue(html, 'Email Open Rate')).toBe('24%');
  });
});
