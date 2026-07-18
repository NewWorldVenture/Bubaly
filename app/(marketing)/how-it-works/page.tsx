import type { Metadata } from 'next';
import { resolveMarketingMetadata } from '@/lib/marketing/seo';
import { HowItWorksReferencePage } from '@/components/marketing/reference-showcases';

export async function generateMetadata(): Promise<Metadata> {
  return resolveMarketingMetadata('/how-it-works', {
    title: 'How It Works',
    description: 'How Bubaly turns scattered family information into organized action.',
  });
}

export default function HowItWorksPage() {
  return <HowItWorksReferencePage />;
}
