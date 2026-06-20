import type { Metadata } from 'next';
import { PricingContent } from './pricing-content';
import { getPublicStats } from '@/lib/marketing/stats';

export const metadata: Metadata = {
  title: 'Pricing',
  description: 'Simple pricing for happier families.',
};

export default async function PricingPage() {
  const { families } = await getPublicStats();
  return <PricingContent familiesCount={families} />;
}
