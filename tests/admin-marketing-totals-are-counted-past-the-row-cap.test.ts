import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { createElement } from 'react';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { fmtMoney } from '@/lib/utils/format';
import { CUSTOMER_FAMILY_CEILING } from '@/lib/marketing/customers';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';
import { renderServerPage, statCardValue } from './helpers/render-server-page';
import { at } from './helpers/source-order';

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

// The overview reduced its Email Open Rate and AEO readiness from two
// unbounded selects, the sibling of the analytics read above (review
// R1-MARKETING-OVERVIEW, R2-SIBLING-OFFSET-SUMS (h)).
describe('/admin/marketing sums every sent email and counts every AEO question', () => {
  async function renderOverview(): Promise<string> {
    const { default: MarketingDashboard } = await import('@/app/(app)/admin/marketing/page');
    return renderServerPage(await MarketingDashboard());
  }

  it('Email Open Rate is over every sent campaign, not the first thousand', async () => {
    // The first thousand were never opened; the 300 after them were, 10 times each.
    db.seed('marketing_email_campaigns', Array.from({ length: 1300 }, (_, i) => ({
      id: `mail-${pad(i)}`, subject: `Mail ${i}`, status: 'sent', recipients: 10, opens: i < CAP ? 0 : 10, clicks: 0, deleted_at: null,
    })));
    const html = await renderOverview();
    // 3,000 opens of 13,000 recipients; the first thousand alone read 0%.
    expect(statCardValue(html, 'Email Open Rate')).toBe('23%');
  });

  it('a deleted campaign is left out of Email Open Rate, as analytics leaves it out', async () => {
    db.seed('marketing_email_campaigns', [
      { id: 'mail-kept', subject: 'Kept', status: 'sent', recipients: 100, opens: 50, clicks: 0, deleted_at: null },
      { id: 'mail-gone', subject: 'Deleted', status: 'sent', recipients: 900, opens: 0, clicks: 0, deleted_at: '2026-06-01T00:00:00Z' },
    ]);
    const html = await renderOverview();
    expect(statCardValue(html, 'Email Open Rate')).toBe('50%');
  });

  it('AEO readiness counts every question, not the first thousand', async () => {
    db.seed('marketing_aeo_questions', Array.from({ length: 1300 }, (_, i) => ({
      id: `aeo-${pad(i)}`, question: `Question ${i}`, status: i < CAP ? 'draft' : i % 2 ? 'answered' : 'published',
    })));
    const html = await renderOverview();
    // 300 answered or published of 1,300; the first thousand alone read 0%.
    expect(html).toContain(`${SOURCE_MESSAGES['adminMarketing.aeoReadiness']}</p><p class="font-semibold">23%</p>`);
    expect(html).toContain('AEO (23%)');
  });

  // Reaching the ceiling used to be the read-error state, which cost the other
  // seven tiles, the lifecycle and the recommended actions with it (review
  // R5-DASHBOARD-CEILING-STILL-WHOLE-PAGE). It costs the open rate alone now.
  it('reaching the row ceiling costs Email Open Rate alone, which says it is not shown, not a smaller open rate', async () => {
    db.seed('marketing_email_campaigns', Array.from({ length: 25_001 }, (_, i) => ({
      id: `mail-${pad(i)}`, subject: `Mail ${i}`, status: 'sent', recipients: 1, opens: 1, clicks: 0, deleted_at: null,
    })));
    db.seed('marketing_aeo_questions', [{ id: 'aeo-1', question: 'Q', status: 'answered' }]);
    const html = await renderOverview();
    expect(html).not.toContain(SOURCE_MESSAGES['marketing.couldNotLoadMarketingDashboard']);
    expect(statCardValue(html, 'Email Open Rate')).toBe(SOURCE_MESSAGES['strategyMetrics.unavailable']);
    expect(bannerItems(html, 25_000)).toEqual(['Email Open Rate']);
    expect(statCardValue(html, 'Total Customers')).toBe('0');
    expect(html).toContain(`${SOURCE_MESSAGES['adminMarketing.aeoReadiness']}</p><p class="font-semibold">100%</p>`);
    expect(html).toContain(SOURCE_MESSAGES['adminMarketing.recommendedNextActions']);
  });

  it('an email read that FAILS is still the read-error state', async () => {
    h.db = withFaults(db, (table) => (table === 'marketing_email_campaigns' ? { message: 'marketing_email_campaigns unavailable' } : null));
    const html = await renderOverview();
    expect(html).toContain(SOURCE_MESSAGES['marketing.couldNotLoadMarketingDashboard']);
    expect(html).not.toContain('Email Open Rate');
  });

  it('past the customer view\'s ceiling the customer figures say they are not shown; the rest of the dashboard stays', async () => {
    seedPastTheCustomerCeiling();
    db.seed('marketing_email_campaigns', [{ id: 'mail-1', subject: 'Mail', status: 'sent', recipients: 10, opens: 5, clicks: 0, deleted_at: null }]);
    const html = await renderOverview();
    expect(html).not.toContain(SOURCE_MESSAGES['marketing.couldNotLoadMarketingDashboard']);
    for (const label of ['Total Customers', 'New This Month', 'Lapsed / Churned', 'Est. MRR']) {
      expect(statCardValue(html, label)).toBe(SOURCE_MESSAGES['strategyMetrics.unavailable']);
    }
    expect(bannerItems(html, CUSTOMER_FAMILY_CEILING)).toEqual(['Total Customers', 'New This Month', 'Lapsed / Churned', 'Est. MRR', SOURCE_MESSAGES['adminMarketing.customerLifecycle']]);
    expect(statCardValue(html, 'Email Open Rate')).toBe('50%');
    // No recommendation is drawn from customers the page did not read.
    expect(html).not.toContain('/admin/marketing/email"');
  });

  it('a customer read that FAILS is still the read-error state', async () => {
    seedPastTheCustomerCeiling();
    h.db = withFaults(db, (table) => (table === 'family_members' ? { message: 'family_members unavailable' } : null));
    const html = await renderOverview();
    expect(html).toContain(SOURCE_MESSAGES['marketing.couldNotLoadMarketingDashboard']);
  });
});

/** 2,001 families, one past the customer view's family ceiling, each a new Plus customer. */
function seedPastTheCustomerCeiling() {
  const families = Array.from({ length: CUSTOMER_FAMILY_CEILING + 1 }, (_, i) => `fam-${pad(i)}`);
  db.seed('families', families.map((id) => ({ id, name: id, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', closed_at: null })));
  db.seed('subscriptions', families.map((id, i) => ({ id: `sub-${pad(i)}`, family_id: id, plan: 'plus', status: 'active', created_at: '2026-10-01T00:00:00Z', current_period_end: null })));
  for (const table of ['family_members', 'profiles']) db.seed(table, []);
}

/** The items of the figures-not-shown banner for a ceiling of `n`, or null when it is not on the page. */
function bannerItems(html: string, n: number): string[] | null {
  const title = translate(SOURCE_MESSAGES, 'adminCeiling.figuresNotShown', { n: n.toLocaleString() });
  const start = html.indexOf(`<p class="text-sm font-semibold text-danger">${title}</p>`);
  if (start < 0) return null;
  return [...html.slice(start, html.indexOf('</ul>', start)).matchAll(/<li>([^<]*)<\/li>/g)].map((m) => m[1]);
}

// /admin/marketing/analytics and /admin/marketing/ads were the read-error state
// past 25,000 campaigns, where the base pages rendered; on ads the New ad
// campaign form went with it (reviews R4-SIB-MARKETING-CAMPAIGN-CEILINGS,
// R5-DASHBOARD-CEILING-STILL-WHOLE-PAGE). A ceiling costs the figures summed
// from that read, which say so; any failure is still the read-error state.
describe('a marketing campaign read past its ceiling costs its figures, not the page', () => {
  const CEILING = 25_000;
  const unavailable = SOURCE_MESSAGES['strategyMetrics.unavailable'];

  async function renderAnalytics(): Promise<string> {
    const { default: AnalyticsPage } = await import('@/app/(app)/admin/marketing/analytics/page');
    return renderServerPage(await AnalyticsPage());
  }
  async function renderAds(): Promise<string> {
    const { default: AdsPage } = await import('@/app/(app)/admin/marketing/ads/page');
    return renderServerPage(await AdsPage());
  }
  const figure = (html: string, label: string) => {
    const match = new RegExp(`${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</p><p class="text-2xl font-bold">([^<]*)</p>`).exec(html);
    if (!match) throw new Error(`no "${label}" figure on the page`);
    return match[1];
  };
  /** 25,001 ad campaigns of $1 budget and 50¢ spend, the newest last. */
  function seedAds() {
    db.seed('marketing_ad_campaigns', Array.from({ length: CEILING + 1 }, (_, i) => ({
      id: `ad-${pad(i)}`, name: `Ad ${i}`, platform: 'meta', objective: null, status: 'planned',
      budget_cents: 100, spend_cents: 50, deleted_at: null, created_at: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
    })));
  }

  it('/admin/marketing/ads: the totals say they are not shown; the exact count, the newest campaigns and the form stay', async () => {
    seedAds();
    const html = await renderAds();
    expect(html).not.toContain(SOURCE_MESSAGES['ads.couldNotLoadAdvertisingCampaigns']);
    expect(figure(html, SOURCE_MESSAGES['adminMarketingAds.campaigns'])).toBe(String(CEILING + 1));
    expect(figure(html, SOURCE_MESSAGES['adminMarketingAds.totalBudget'])).toBe(unavailable);
    expect(figure(html, SOURCE_MESSAGES['adminMarketingAds.totalSpend'])).toBe(unavailable);
    expect(bannerItems(html, CEILING)).toEqual([SOURCE_MESSAGES['adminMarketingAds.totalBudget'], SOURCE_MESSAGES['adminMarketingAds.totalSpend']]);
    // The newest 500, newest first, and the list says so.
    expect(html).toContain(`>Ad ${CEILING}</p>`);
    expect(html).toContain(`>Ad ${CEILING + 1 - 500}</p>`);
    expect(html).not.toContain(`>Ad ${CEILING - 500}</p>`);
    expect(at(html, `>Ad ${CEILING}</p>`)).toBeLessThan(at(html, `>Ad ${CEILING - 1}</p>`));
    expect(html).toContain(translate(SOURCE_MESSAGES, 'adminMarketingAds.theListIsTheNewest', { n: '500' }));
    expect(html).toContain(SOURCE_MESSAGES['adminMarketingAds.newAdCampaign']);
    expect(html).toContain('name="budgetDollars"');
  });

  it('/admin/marketing/ads: a campaign read that FAILS is still the read-error state', async () => {
    seedAds();
    h.db = withFaults(db, (table) => (table === 'marketing_ad_campaigns' ? { message: 'marketing_ad_campaigns unavailable' } : null));
    const html = await renderAds();
    expect(html).toContain(SOURCE_MESSAGES['ads.couldNotLoadAdvertisingCampaigns']);
    expect(html).not.toContain('name="budgetDollars"');
  });

  it('/admin/marketing/ads: the control — under the ceiling the list is whole and nothing is withheld', async () => {
    db.seed('marketing_ad_campaigns', Array.from({ length: 600 }, (_, i) => ({
      id: `ad-${pad(i)}`, name: `Ad ${i}`, platform: 'meta', objective: null, status: 'planned',
      budget_cents: 100, spend_cents: 50, deleted_at: null, created_at: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
    })));
    const html = await renderAds();
    expect(html).toContain('>Ad 0</p>');
    expect(figure(html, SOURCE_MESSAGES['adminMarketingAds.totalBudget'])).toBe(fmtMoney(600 * 100));
    expect(bannerItems(html, CEILING)).toBeNull();
    expect(html).not.toContain(translate(SOURCE_MESSAGES, 'adminMarketingAds.theListIsTheNewest', { n: '500' }));
  });

  it('/admin/marketing/analytics: past 25,000 campaigns and 25,000 emails their figures say they are not shown; the customer figures stay', async () => {
    db.seed('families', [{ id: 'fam-1', name: 'Family 1', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', closed_at: null }]);
    db.seed('subscriptions', [{ id: 'sub-1', family_id: 'fam-1', plan: 'plus', status: 'active', created_at: '2026-10-01T00:00:00Z', current_period_end: null }]);
    for (const table of ['family_members', 'profiles']) db.seed(table, []);
    db.seed('marketing_campaigns', Array.from({ length: CEILING + 1 }, (_, i) => ({ id: `camp-${pad(i)}`, name: `C ${i}`, channel: 'email', status: 'active', budget_cents: 100, deleted_at: null })));
    db.seed('marketing_email_campaigns', Array.from({ length: CEILING + 1 }, (_, i) => ({ id: `mail-${pad(i)}`, subject: `M ${i}`, status: 'sent', recipients: 10, opens: 2, clicks: 1, deleted_at: null })));
    const html = await renderAnalytics();
    expect(html).not.toContain(SOURCE_MESSAGES['analytics.couldNotLoadMarketingAnalytics']);
    expect(figure(html, SOURCE_MESSAGES['adminMarketingAnalytics.emailOpenRate'])).toBe(unavailable);
    expect(html).toContain(`<p class="text-2xl font-bold">${unavailable}</p><p class="text-xs text-muted">${SOURCE_MESSAGES['adminMarketingAnalytics.recipients']}`);
    expect(html).not.toContain(' campaigns · ');
    expect(bannerItems(html, CEILING)).toEqual(['campaignsByChannel', 'emailOpenRate', 'emailPerformance'].map((k) => SOURCE_MESSAGES[`adminMarketingAnalytics.${k}`]));
    expect(figure(html, SOURCE_MESSAGES['adminMarketingAnalytics.customers'])).toBe('1');
    expect(bannerItems(html, CUSTOMER_FAMILY_CEILING)).toBeNull();
  });

  it('/admin/marketing/analytics: past the customer view\'s ceiling the customer figures say they are not shown; the campaign figures stay', async () => {
    seedPastTheCustomerCeiling();
    db.seed('marketing_campaigns', [{ id: 'camp-1', name: 'C', channel: 'social', status: 'active', budget_cents: 500, deleted_at: null }]);
    db.seed('marketing_email_campaigns', []);
    const html = await renderAnalytics();
    expect(html).not.toContain(SOURCE_MESSAGES['analytics.couldNotLoadMarketingAnalytics']);
    for (const key of ['customers', 'paying', 'estMrr']) expect(figure(html, SOURCE_MESSAGES[`adminMarketingAnalytics.${key}`])).toBe(unavailable);
    expect(bannerItems(html, CUSTOMER_FAMILY_CEILING)).toEqual(['customers', 'paying', 'estMrr', 'customerAcquisition', 'estRevenueInfluencedMonthly'].map((k) => SOURCE_MESSAGES[`adminMarketingAnalytics.${k}`]));
    expect(html).toContain(`1 campaign · ${fmtMoney(500)}`);
  });

  it('/admin/marketing/analytics: a campaign read that FAILS is still the read-error state', async () => {
    for (const table of ['families', 'subscriptions', 'family_members', 'profiles', 'marketing_email_campaigns']) db.seed(table, []);
    h.db = withFaults(db, (table) => (table === 'marketing_campaigns' ? { message: 'marketing_campaigns unavailable' } : null));
    expect(await renderAnalytics()).toContain(SOURCE_MESSAGES['analytics.couldNotLoadMarketingAnalytics']);
  });
});
