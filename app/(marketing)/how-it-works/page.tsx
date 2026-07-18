import type { Metadata } from 'next';
import { resolveMarketingMetadata } from '@/lib/marketing/seo';
import { HowItWorksReferencePage } from '@/components/marketing/reference-showcases';
import { MarketingAeoSection } from '@/components/marketing/marketing-aeo-section';

export async function generateMetadata(): Promise<Metadata> {
  return resolveMarketingMetadata('/how-it-works', {
    title: 'How It Works',
    description: 'How Bubaly turns scattered family information into organized action.',
  });
}

export default async function HowItWorksPage() {
  return <><HowItWorksReferencePage /><MarketingAeoSection path="/how-it-works" name="How Bubaly Works" description="How Bubaly turns scattered family information into organized action." /></>;
}
