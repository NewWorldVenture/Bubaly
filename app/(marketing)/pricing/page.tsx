import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { resolveMarketingMetadata } from '@/lib/marketing/seo';
import { PricingContent } from './pricing-content';
import { getPublicStats } from '@/lib/marketing/stats';
import { createServiceClient } from '@/lib/supabase/server';
import { getResolvedFeatureTiers } from '@/lib/server/feature-tiers';
import { FEATURE_CATALOG, FEATURE_SECTIONS } from '@/lib/constants/feature-catalog';
import type { FeatureTier } from '@/lib/constants/feature-catalog';
import { MarketingAeoSection } from '@/components/marketing/marketing-aeo-section';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return resolveMarketingMetadata('/pricing', {
    title: 'Pricing',
    description: t('pricing.simplePricingForHappierFamilies'),
  });
}

export const dynamic = 'force-dynamic';

export default async function PricingPage() {
  const t = await getTranslations();
  const { families } = await getPublicStats();
  // Build the admin-controlled feature matrix (Off/Free/Basic/Plus per service)
  // so the pricing page reflects the Tier & Features admin live.
  const resolved = await getResolvedFeatureTiers(createServiceClient());
  const matrix = FEATURE_SECTIONS.map((section) => ({
    section,
    items: FEATURE_CATALOG
      .filter((f) => f.section === section && (resolved[f.key] ?? f.defaultTier) !== 'off')
      .map((f) => ({ label: f.label, tier: (resolved[f.key] ?? f.defaultTier) as Exclude<FeatureTier, 'off'> })),
  })).filter((s) => s.items.length > 0);

  return <><PricingContent familiesCount={families} featureMatrix={matrix} /><MarketingAeoSection path="/pricing" name="Bubaly Pricing" description={t('pricing.simplePricingForHappierFamilies')} /></>;
}
