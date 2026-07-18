import type { Metadata } from 'next';
import { resolveMarketingMetadata } from '@/lib/marketing/seo';
import { FeaturesReferencePage } from '@/components/marketing/reference-showcases';
import { MarketingAeoSection } from '@/components/marketing/marketing-aeo-section';

export async function generateMetadata(): Promise<Metadata> {
  return resolveMarketingMetadata('/features', {
    title: 'Features',
    description: 'Everything your family needs in one intelligent place.',
  });
}

export default async function FeaturesPage() {
  return <><FeaturesReferencePage /><MarketingAeoSection path="/features" name="Bubaly Features" description="Everything your family needs in one intelligent place." /></>;
}
