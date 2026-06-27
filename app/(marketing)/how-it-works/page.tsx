import type { Metadata } from 'next';
import { HowItWorksReferencePage } from '@/components/marketing/reference-showcases';

export const metadata: Metadata = {
  title: 'How It Works',
  description: 'How Bubaly quietly handles the invisible work of family life — so you spend less time managing life and more time living it.',
};

export default function HowItWorksPage() {
  return <HowItWorksReferencePage />;
}
