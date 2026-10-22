import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { createElement } from 'react';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { fmtMoney } from '@/lib/utils/format';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { renderServerPage } from './helpers/render-server-page';

// Three marketing admin pages summed or tallied an unbounded read:
//
//   forms      `marketing_form_submissions.select('form_id')`, tallied per form
//   analytics  campaigns summed per channel, sent emails summed for recipients,
//              opens and clicks
//   ads        campaign count, total budget and total spend
//
// PostgREST answers each with at most 1,000 rows and no error, so past a
// thousand submissions a form's count stopped growing — and a form whose
// submissions were all outside the prefix read 0.
const CAP = 1000;
const pad = (i: number) => String(i).padStart(6, '0');

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
// The pages bind server actions to their forms; the actions are not driven here.
vi.mock('@/app/(app)/admin/marketing/actions', () => ({
  createForm: async () => {},
  setFormStatus: async () => {},
  createAdCampaign: async () => {},
}));

let db: InMemorySupabase;

beforeEach(() => {
  db = createInMemorySupabase({ maxRows: CAP });
  h.db = db;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('/admin/marketing/forms counts every submission per form', () => {
  it('a form whose submissions all sit past the first thousand is not 0', async () => {
    db.seed('marketing_forms', [
      { id: 'form-a', name: 'Form A', fields: [], status: 'active', deleted_at: null, created_at: '2026-01-02T00:00:00Z' },
      { id: 'form-b', name: 'Form B', fields: [], status: 'active', deleted_at: null, created_at: '2026-01-01T00:00:00Z' },
    ]);
    db.seed('marketing_form_submissions', Array.from({ length: 1300 }, (_, i) => ({
      id: `sub-${pad(i)}`, form_id: i < CAP ? 'form-a' : 'form-b', created_at: '2026-02-01T00:00:00Z',
    })));
    const { default: FormsPage } = await import('@/app/(app)/admin/marketing/forms/page');
    const html = await renderServerPage(await FormsPage());
    const cardB = html.slice(html.indexOf('Form B'));
    expect(cardB).toMatch(/<p class="font-semibold">300<\/p><p class="text-xs text-muted">submissions/);
    expect(html.slice(html.indexOf('Form A'), html.indexOf('Form B'))).toMatch(/<p class="font-semibold">1000<\/p>/);
  });
});

describe('/admin/marketing/analytics sums every campaign and every sent email', () => {
  it('channel budgets and email engagement are totals, not the first thousand', async () => {
    db.seed('families', []);
    db.seed('subscriptions', []);
    db.seed('family_members', []);
    db.seed('profiles', []);
    db.seed('marketing_campaigns', Array.from({ length: 1300 }, (_, i) => ({
      id: `camp-${pad(i)}`, name: `Campaign ${i}`, channel: 'email', status: 'active', budget_cents: 100, deleted_at: null,
    })));
    db.seed('marketing_email_campaigns', Array.from({ length: 1300 }, (_, i) => ({
      id: `mail-${pad(i)}`, subject: `Mail ${i}`, status: 'sent', recipients: 10, opens: 2, clicks: 1, deleted_at: null,
    })));
    const { default: AnalyticsPage } = await import('@/app/(app)/admin/marketing/analytics/page');
    const html = await renderServerPage(await AnalyticsPage());
    expect(html).toContain(`1300 campaigns · ${fmtMoney(1300 * 100)}`);
    expect(html).toContain(`<p class="text-2xl font-bold">13000</p><p class="text-xs text-muted">${SOURCE_MESSAGES['adminMarketingAnalytics.recipients']}`);
    expect(html).toContain(`<p class="text-2xl font-bold">2600</p><p class="text-xs text-muted">${SOURCE_MESSAGES['adminMarketingAnalytics.opens']}`);
    expect(html).toContain(`<p class="text-2xl font-bold">1300</p><p class="text-xs text-muted">${SOURCE_MESSAGES['adminMarketingAnalytics.clicks']}`);
  });
});

describe('/admin/marketing/ads totals every campaign', () => {
  it('the campaign count, budget and spend are totals, not the first thousand', async () => {
    db.seed('marketing_ad_campaigns', Array.from({ length: 1300 }, (_, i) => ({
      id: `ad-${pad(i)}`, name: `Ad ${i}`, platform: 'meta', objective: null, status: 'planned',
      budget_cents: 100, spend_cents: 50, deleted_at: null, created_at: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
    })));
    const { default: AdsPage } = await import('@/app/(app)/admin/marketing/ads/page');
    const html = await renderServerPage(await AdsPage());
    expect(html).toContain(`${SOURCE_MESSAGES['adminMarketingAds.campaigns']}</p><p class="text-2xl font-bold">1300</p>`);
    expect(html).toContain(`${SOURCE_MESSAGES['adminMarketingAds.totalBudget']}</p><p class="text-2xl font-bold">${fmtMoney(1300 * 100)}</p>`);
    expect(html).toContain(`${SOURCE_MESSAGES['adminMarketingAds.totalSpend']}</p><p class="text-2xl font-bold">${fmtMoney(1300 * 50)}</p>`);
  });
});
