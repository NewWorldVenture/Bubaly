import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { PetsModule } from '@/components/modules/pets-module';

export const metadata: Metadata = { title: 'Pets' };

export default async function PetsPage() {
  await requireFeature('/dashboard/pets');
  return <PetsModule />;
}
