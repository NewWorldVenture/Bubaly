import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireFeature } from '@/lib/supabase/auth';
import { PantryModule } from '@/components/modules/pantry-module';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('pantry.pantryInventory') };
}

export default async function PantryPage() {
  // Catalog-driven gating (Pantry is Free) instead of a hardcoded plan level.
  await requireFeature('/dashboard/pantry');
  return <PantryModule />;
}
