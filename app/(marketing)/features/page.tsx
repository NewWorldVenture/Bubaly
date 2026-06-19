import type { Metadata } from 'next';
import { FeaturesReferencePage } from '@/components/marketing/reference-showcases';

export const metadata: Metadata = {
  title: 'Features',
  description: 'Everything your family needs in one intelligent place.',
};

export default function FeaturesPage() {
  return <FeaturesReferencePage />;
}
