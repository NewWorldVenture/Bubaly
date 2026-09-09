import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Metadata } from 'next';
import { getMessages } from '@/lib/i18n/messages';
import { LOCALES } from '@/lib/i18n/locales';

const request = vi.hoisted(() => ({ locale: 'en-US', service: vi.fn(), server: vi.fn() }));
// Next provides the server React cache API; the root unit-test runtime uses
// client React. No cached data loader is called when resolving these titles.
vi.mock('react', async (original) => ({ ...await original<typeof import('react')>(), cache: <T>(fn: T) => fn }));
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (key: string) => key === 'bubaly-locale' ? { value: request.locale } : undefined }),
  headers: async () => new Headers(),
}));
vi.mock('@/lib/supabase/server', async (original) => ({
  ...await original<typeof import('@/lib/supabase/server')>(),
  createServiceClient: request.service, createServer: request.server,
}));

const routes = [
  { key: 'auditLogs.auditLogs', admin: true, load: () => import('../app/(app)/admin/audit-logs/page') },
  { key: 'audit.auditLogs', admin: true, load: () => import('../app/(app)/admin/audit/page') },
  { key: 'content.contentManagement', admin: true, load: () => import('../app/(app)/admin/content/page') },
  { key: 'integrations.integrations', admin: true, load: () => import('../app/(app)/admin/integrations/page') },
  { key: 'affiliates.affiliates', admin: true, load: () => import('../app/(app)/admin/marketing/affiliates/page') },
  { key: 'assets.assetLibrary', admin: true, load: () => import('../app/(app)/admin/marketing/assets/page') },
  { key: 'competitive.competitiveIntelligence', admin: true, load: () => import('../app/(app)/admin/marketing/competitive/page') },
  { key: 'exitIntent.exitIntentPopups', admin: true, load: () => import('../app/(app)/admin/marketing/exit-intent/page') },
  { key: 'experiments.aBTesting', admin: true, load: () => import('../app/(app)/admin/marketing/experiments/page') },
  { key: 'health.customerHealth', admin: true, load: () => import('../app/(app)/admin/marketing/health/page') },
  { key: 'intelligence.customerIntelligence', admin: true, load: () => import('../app/(app)/admin/marketing/intelligence/page') },
  { key: 'leadScores.leadScores', admin: true, load: () => import('../app/(app)/admin/marketing/lead-scores/page') },
  { key: 'leads.leadScoring', admin: true, load: () => import('../app/(app)/admin/marketing/leads/page') },
  { key: 'marketing.marketing', admin: true, load: () => import('../app/(app)/admin/marketing/page') },
  { key: 'personalization.personalization', admin: true, load: () => import('../app/(app)/admin/marketing/personalization/page') },
  { key: 'pipeline.salesPipeline', admin: true, load: () => import('../app/(app)/admin/marketing/pipeline/page') },
  { key: 'referrals.referrals', admin: true, load: () => import('../app/(app)/admin/marketing/referrals/page') },
  { key: 'video.videoMarketing', admin: true, load: () => import('../app/(app)/admin/marketing/video/page') },
  { key: 'reports.marketplaceReports', admin: true, load: () => import('../app/(app)/admin/marketplace/reports/page') },
  { key: 'onboarding.onboardingAudit', admin: true, load: () => import('../app/(app)/admin/onboarding/page') },
  { key: 'subscriptions.subscriptions', admin: true, load: () => import('../app/(app)/admin/subscriptions/page') },
  { key: 'supportTickets.supportTickets', admin: true, load: () => import('../app/(app)/admin/support-tickets/page') },
  { key: 'support.supportTickets', admin: true, load: () => import('../app/(app)/admin/support/page') },
  { key: 'system.systemOverview', admin: true, load: () => import('../app/(app)/admin/system/page') },
  { key: 'contacts.contactTimeline', admin: false, load: () => import('../app/(app)/dashboard/contacts/[id]/page') },
  { key: 'familyOperations.familyOperations', admin: false, load: () => import('../app/(app)/dashboard/family-operations/page') },
  { key: 'familySignals.familyIntelligence', admin: false, load: () => import('../app/(app)/dashboard/family-signals/page') },
  { key: 'more.more', admin: false, load: () => import('../app/(app)/dashboard/more/page') },
  { key: 'dashboard.home', admin: false, load: () => import('../app/(app)/dashboard/page') },
  { key: 'reports.familyReports', admin: false, load: () => import('../app/(app)/family/reports/page') },
  { key: 'welcome.welcomeToBubaly', admin: false, load: () => import('../app/(auth)/welcome/page') },
];
let pages: { key: string; admin: boolean; generate: () => Promise<Metadata> }[];
beforeAll(async () => {
  pages = await Promise.all(routes.map(async (route) => ({ ...route, generate: (await route.load()).generateMetadata })));
}, 30000);

describe('request-localized browser titles', () => {
  it.each(LOCALES.map(locale => locale.code))('resolves all affected titles in %s without reading household data', async (locale) => {
    request.locale = locale;
    const messages = getMessages(locale);
    for (const page of pages) {
      const result = await page.generate();
      expect(result.title).toBe(messages[page.key]);
      expect(result.title).not.toBe(page.key);
      expect(result.robots).toEqual(page.admin ? { index: false } : undefined);
    }
    expect(request.service).not.toHaveBeenCalled();
    expect(request.server).not.toHaveBeenCalled();
  });
  it('does not retain a previous request’s language', async () => {
    const home = pages.find(page => page.key === 'dashboard.home')!;
    request.locale = 'de-DE';
    expect((await home.generate()).title).toBe(getMessages('de-DE')['dashboard.home']);
    request.locale = 'fr-FR';
    expect((await home.generate()).title).toBe(getMessages('fr-FR')['dashboard.home']);
  });
});
