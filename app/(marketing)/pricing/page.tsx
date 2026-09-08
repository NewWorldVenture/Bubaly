import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { resolveMarketingMetadata } from '@/lib/marketing/seo';
import { PricingContent } from './pricing-content';
import { getPublicStats } from '@/lib/marketing/stats';
import { sampleBriefNumbers } from '@/lib/marketing/handled-sample';
import { getPublishedCaseStudies } from '@/lib/marketing/reputation-server';
import { SwitchingBand } from '@/components/marketing/switching-band';
import { createServiceClient } from '@/lib/supabase/server';
import { getResolvedFeatureTiers } from '@/lib/server/feature-tiers';
import { FEATURE_CATALOG, FEATURE_SECTIONS } from '@/lib/constants/feature-catalog';
import type { FeatureTier } from '@/lib/constants/feature-catalog';
import { MarketingAeoSection } from '@/components/marketing/marketing-aeo-section';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return resolveMarketingMetadata('/pricing', {
    title: t('pricing.pricing'),
    description: t('pricing.simplePricingForHappierFamilies'),
  });
}

export const dynamic = 'force-dynamic';

export default async function PricingPage() {
  const t = await getTranslations();
  // The value block's three sources are read here, on the server, and handed
  // to the client page as props: the REAL cross-family counts
  // (public_handled_stats), the ILLUSTRATIVE sample numbers (the app's own
  // brief composer over a fixed week) and the admin-published case studies.
  // pricing-content.tsx is a client module and can reach none of them itself.
  //
  // Neither cached reader can reject — each catches its own failure and
  // returns zeros or an empty list, which the page then HIDES rather than
  // prints — so nothing here rides in settleAll and nothing is orphaned if
  // the feature-tier read throws.
  const [stats, caseStudies, resolved] = await Promise.all([
    getPublicStats(),
    getPublishedCaseStudies(),
    // Build the admin-controlled feature matrix (Off/Free/Basic/Plus per service)
    // so the pricing page reflects the Tier & Features admin live.
    getResolvedFeatureTiers(createServiceClient()),
  ]);
  const matrix = FEATURE_SECTIONS.map((section) => ({
    section,
    items: FEATURE_CATALOG
      .filter((f) => f.section === section && (resolved[f.key] ?? f.defaultTier) !== 'off')
      .map((f) => ({ label: f.label, tier: (resolved[f.key] ?? f.defaultTier) as Exclude<FeatureTier, 'off'> })),
  })).filter((s) => s.items.length > 0);

  return (
    <>
      <PricingContent
        familiesCount={stats.families}
        featureMatrix={matrix}
        handledStats={{ handledCompleted: stats.handledCompleted, handled30d: stats.handled30d }}
        sampleNumbers={sampleBriefNumbers()}
        caseStudies={caseStudies.slice(0, 2).map((study) => ({
          id: study.id,
          title: study.title,
          customerName: study.customerName,
          summary: study.summary,
          resultMetric: study.resultMetric,
          // Only an admin can set case_studies.verified_at; the column is read
          // loosely in reputation-server.ts until its migration lands, so an
          // unverified story simply carries no badge.
          verified: Boolean(study.verifiedAt),
        }))}
        switching={<SwitchingBand compact />}
      />
      <MarketingAeoSection path="/pricing" name={t('pricing.bubalyPricing')} description={t('pricing.simplePricingForHappierFamilies')} />
    </>
  );
}
