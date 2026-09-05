import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { InventoryModule } from '@/components/modules/inventory-module';

export const metadata: Metadata = { title: 'Home Inventory' };

export default async function InventoryPage() {
  await requireFeature('/dashboard/inventory');
  return <InventoryModule />;
}
