import type { Metadata } from 'next';
import { FamilyModule } from '@/components/modules/family-module';

export const metadata: Metadata = { title: 'Family' };

export default function FamilyPage() {
  return <FamilyModule />;
}
