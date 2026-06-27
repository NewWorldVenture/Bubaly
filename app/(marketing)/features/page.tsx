import type { Metadata } from 'next';
import { FeaturesReferencePage } from '@/components/marketing/reference-showcases';

export const metadata: Metadata = {
  title: 'Features',
  description: 'Everything your family needs to spend less time managing life and more time living it — calendar, tasks, meals, school, health, documents, and an AI assistant that takes real action.',
};

export default function FeaturesPage() {
  return <FeaturesReferencePage />;
}
