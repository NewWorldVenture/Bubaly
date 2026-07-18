import type { Metadata } from 'next';
import { MarketingPageView, marketingPageMetadata } from '@/lib/marketing/public-pages';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  return marketingPageMetadata('feature', (await params).slug);
}

export default async function FeaturePage({ params }: { params: Promise<{ slug: string }> }) {
  return <MarketingPageView type="feature" slug={(await params).slug} />;
}
