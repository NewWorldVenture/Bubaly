import type { Metadata } from 'next';
import { resolveMarketingMetadata } from '@/lib/marketing/seo';
import { FeaturesReferencePage } from '@/components/marketing/reference-showcases';

export async function generateMetadata(): Promise<Metadata> {
  return resolveMarketingMetadata('/features', {
    title: 'Features',
    description: 'Everything your family needs in one intelligent place.',
  });
}

export default function FeaturesPage() {
  return <FeaturesReferencePage />;
}
