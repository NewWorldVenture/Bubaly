import type { Metadata } from 'next';
import { HowItWorksReferencePage } from '@/components/marketing/reference-showcases';

export const metadata: Metadata = {
  title: 'How It Works',
  description: 'How Bubaly turns scattered family information into organized action.',
};

export default function HowItWorksPage() {
  return <HowItWorksReferencePage />;
}
