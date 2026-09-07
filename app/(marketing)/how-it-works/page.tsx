import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { resolveMarketingMetadata } from '@/lib/marketing/seo';
import { HowItWorksReferencePage } from '@/components/marketing/reference-showcases';
import { MarketingAeoSection } from '@/components/marketing/marketing-aeo-section';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return resolveMarketingMetadata('/how-it-works', {
    title: t('howItWorks.howItWorks'),
    description: t('howItWorks.howBubalyTurnsScatteredFamily'),
  });
}

export default async function HowItWorksPage() {
  const t = await getTranslations();
  return <><HowItWorksReferencePage /><MarketingAeoSection path="/how-it-works" name={t('howItWorks.howBubalyWorks')} description={t('howItWorks.howBubalyTurnsScatteredFamily')} /></>;
}
