import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { resolveMarketingMetadata } from '@/lib/marketing/seo';
import { FeaturesReferencePage } from '@/components/marketing/reference-showcases';
import { MarketingAeoSection } from '@/components/marketing/marketing-aeo-section';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return resolveMarketingMetadata('/features', {
    title: t('featuresPage.metaTitle'),
    description: t('features.everythingYourFamilyNeedsIn'),
  });
}

export default async function FeaturesPage() {
  const t = await getTranslations();
  return <><FeaturesReferencePage /><MarketingAeoSection path="/features" name={t('features.bubalyFeatures')} description={t('features.everythingYourFamilyNeedsIn')} /></>;
}
