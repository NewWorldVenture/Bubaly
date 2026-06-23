import type { Metadata } from 'next';
import { requirePlanLevel } from '@/lib/supabase/auth';
import { PantryModule } from '@/components/modules/pantry-module';

export const metadata: Metadata = { title: 'Pantry & Inventory' };

export default async function PantryPage() {
  await requirePlanLevel(1);
  return <PantryModule />;
}
