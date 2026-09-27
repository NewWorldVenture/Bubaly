import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireFeature } from '@/lib/supabase/auth';
import { InventoryModule } from '@/components/modules/inventory-module';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.homeInventory') };
}

export default async function InventoryPage() {
  await requireFeature('/dashboard/inventory');
  return <InventoryModule />;
}
