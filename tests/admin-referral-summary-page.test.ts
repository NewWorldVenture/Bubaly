import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cloneElement, createElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LocaleProvider } from '@/components/i18n/locale-provider';
import { getMessages, translate } from '@/lib/i18n/messages';
import { localeOrDefault, type LocaleCode } from '@/lib/i18n/locales';
import { DEFAULT_REFERRAL_CONFIG } from '@/lib/referrals/core';
import type { AdminReferralSummary } from '@/lib/referrals/admin-summary';

const mocks = vi.hoisted(() => ({
  summary: vi.fn(), config: vi.fn(), client: vi.fn(), save: vi.fn(),
}));
let locale: LocaleCode = 'en-US';
const db = { boundary: 'admin-service-client' };

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => mocks.client() }));
vi.mock('@/lib/referrals/admin-summary', () => ({ loadAdminReferralSummary: (...args: unknown[]) => mocks.summary(...args) }));
vi.mock('@/lib/referrals/server', () => ({ getReferralConfigResult: (...args: unknown[]) => mocks.config(...args) }));
vi.mock('@/app/(app)/admin/marketing/referrals/actions', () => ({ saveReferralConfigAction: (...args: unknown[]) => mocks.save(...args) }));
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(getMessages(locale), key, params),
  getLocaleContext: async () => ({ locale: localeOrDefault(locale), source: 'cookie', messages: getMessages(locale) }),
}));

function summary(overrides: Partial<AdminReferralSummary> = {}): AdminReferralSummary {
  return {
    total: 1234, converted: 617, conversionRate: 0.5, unconfirmedReferrerCents: 8750,
    untilIso: '2026-09-09T12:00:00.000Z',
    recent: [
      { id: 'recent-1', code: 'RECENT-ONE', referrer_family_id: 'recent-family', referred_email: 'recent-one@example.test', status: 'pending', referrer_reward_cents: 99900, created_at: '2026-09-09T10:00:00.000Z', metadata: {} },
      { id: 'recent-2', code: 'RECENT-TWO', referrer_family_id: 'recent-family', referred_email: 'recent-two@example.test', status: 'rewarded', referrer_reward_cents: 2500, created_at: '2026-09-08T10:00:00.000Z', metadata: { reward: { referrer_txn: 'receipt' } } },
    ],
    topReferrers: [['historical-leading-family', 411], ['recent-family', 8]],
    ...overrides,
  };
}

// React 18's static renderer does not await nested server components. Resolve
// only async server elements; ordinary components still render through React.
async function resolveServerChildren(node: ReactNode): Promise<ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(resolveServerChildren));
  if (!isValidElement<{ children?: ReactNode }>(node)) return node;
  if (typeof node.type === 'function' && node.type.constructor.name === 'AsyncFunction') {
    const component = node.type as (props: unknown) => Promise<ReactNode>;
    return resolveServerChildren(await component(node.props));
  }
  if (!Object.prototype.hasOwnProperty.call(node.props, 'children')) return node;
  return cloneElement(node, {}, await resolveServerChildren(node.props.children));
}

async function renderPage() {
  const { default: Page } = await import('@/app/(app)/admin/marketing/referrals/page');
  const tree = await resolveServerChildren(await Page());
  const html = renderToStaticMarkup(createElement(LocaleProvider, {
    locale: localeOrDefault(locale), source: 'cookie', messages: getMessages(locale),
  } as Parameters<typeof LocaleProvider>[0], tree));
  return { html, text: html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() };
}

beforeEach(() => {
  vi.clearAllMocks();
  locale = 'en-US';
  mocks.client.mockReturnValue(db);
  mocks.summary.mockResolvedValue({ data: summary(), error: null });
  mocks.config.mockResolvedValue({ config: DEFAULT_REFERRAL_CONFIG, error: null });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('admin referral summary page', () => {
  it('renders complete totals and historical leaders independently of the recent table', async () => {
    const { html, text } = await renderPage();
    expect(mocks.summary).toHaveBeenCalledWith(db);
    expect(mocks.config).toHaveBeenCalledWith(db);
    expect(text).toContain('1,234 Total referrals');
    expect(text).toContain('617 Converted');
    expect(text).toContain('50% Conversion rate');
    expect(text).toContain('$87.50 Unconfirmed referrer credits');
    expect(text).toContain('historical-leading-family 411');
    expect(text).toContain('RECENT-ONE');
    expect(text).toContain('RECENT-TWO');
    const tableBody = html.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] ?? '';
    expect(tableBody.match(/<tr\b/g)).toHaveLength(2);
    expect(text).not.toContain('Credits Owed');
    expect(text).toContain('Totals and rankings cover all recorded referrals created through');
    expect(text).toContain('the table shows the 25 newest.');
    expect(text).toContain('converted and rewarded referrals divided by all recorded referrals.');
    expect(text).toContain('Unconfirmed credits cover the referrer side of converted referrals only.');
    expect(text).toContain('A missing receipt can include a provider credit whose recording failed.');
  });

  it('distinguishes no referral denominator from a measured zero conversion rate', async () => {
    mocks.summary.mockResolvedValue({ data: summary({
      total: 0, converted: 0, conversionRate: null, unconfirmedReferrerCents: 0,
      recent: [], topReferrers: [],
    }), error: null });
    const empty = await renderPage();
    expect(empty.text).toContain('0 Total referrals');
    expect(empty.text).toContain('No referrals yet. Conversion rate');
    expect(empty.text).not.toContain('0%');
    expect(empty.text).toContain('No referrers yet.');
    expect(empty.html).toContain('name="referrerRewardDollars"');

    const pending = summary().recent[0];
    mocks.summary.mockResolvedValue({ data: summary({
      total: 1, converted: 0, conversionRate: 0, unconfirmedReferrerCents: 0,
      recent: [pending], topReferrers: [[pending.referrer_family_id, 1]],
    }), error: null });
    const measuredZero = await renderPage();
    expect(measuredZero.text).toContain('0% Conversion rate');
    expect(measuredZero.text).not.toContain('No referrals yet.');
  });

  it('shows all 25 supplied recent rows without truncating the full summary', async () => {
    const sample = summary().recent[0];
    const recent = Array.from({ length: 25 }, (_, i) => ({
      ...sample, id: 'row-' + i, code: 'LATEST-' + String(i + 1).padStart(2, '0'),
    }));
    mocks.summary.mockResolvedValue({ data: summary({ recent }), error: null });
    const { html, text } = await renderPage();
    const tableBody = html.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1] ?? '';
    expect(tableBody.match(/<tr\b/g)).toHaveLength(25);
    expect(text).toContain('LATEST-25');
    expect(text).toContain('1,234 Total referrals');
  });

  it('renders translated summary, statuses and methodology in the selected locale', async () => {
    locale = 'de-DE';
    const { text } = await renderPage();
    expect(text).toContain('Empfehlungen insgesamt');
    expect(text).toContain('Konversionsrate');
    expect(text).toContain('Unbestätigte Empfehlungsprämien');
    expect(text).toContain('Ausstehend');
    expect(text).toContain('Prämiert');
    expect(text).toContain('Summen und Ranglisten berücksichtigen alle bis zum');
    expect(text).toContain('Ein fehlender Beleg kann auch eine Anbietergutschrift betreffen');
    expect(text).not.toContain('Total referrals');
    expect(text).not.toContain('referralAdmin.');
  });

  it.each(['summary-error', 'summary-reject', 'config-error', 'config-reject', 'client-throw'] as const)(
    'renders an explicit retry state for %s instead of zero totals or settings defaults',
    async (failure) => {
      const error = new Error('Simulated unavailable admin read');
      if (failure === 'summary-error') mocks.summary.mockResolvedValue({ data: null, error });
      if (failure === 'summary-reject') mocks.summary.mockRejectedValue(error);
      if (failure === 'config-error') mocks.config.mockResolvedValue({ config: DEFAULT_REFERRAL_CONFIG, error });
      if (failure === 'config-reject') mocks.config.mockRejectedValue(error);
      if (failure === 'client-throw') mocks.client.mockImplementation(() => { throw error; });
      const { html, text } = await renderPage();
      expect(text).toContain('Could not load referral settings and activity from Supabase. Refresh and try again.');
      expect(html).toContain('href="/admin/marketing/referrals"');
      expect(text).toContain('Refresh referrals');
      expect(html).not.toContain('<tbody>');
      expect(html).not.toContain('name="referrerRewardDollars"');
      expect(text).not.toContain('Total referrals');
      expect(text).not.toContain('0%');
    },
  );
});
