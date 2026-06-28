import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { PantryModule } from '@/components/modules/pantry-module';

export const metadata: Metadata = { title: 'Pantry & Inventory' };

export default async function PantryPage() {
  // Catalog-driven gating (Pantry is Free) instead of a hardcoded plan level.
  await requireFeature('/dashboard/pantry');
  return <PantryModule />;
}
