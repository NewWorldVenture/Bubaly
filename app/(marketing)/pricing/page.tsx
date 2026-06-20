import type { Metadata } from 'next';
import { PricingContent } from './pricing-content';

export const metadata: Metadata = {
  title: 'Pricing',
  description: 'Simple pricing for happier families.',
};

export default function PricingPage() {
  return <PricingContent />;
}
