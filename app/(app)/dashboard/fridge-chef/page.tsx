import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { PageHeader } from '@/components/app/page-header';
import { FridgeChef } from '@/components/meals/fridge-chef';
import { getTranslations } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('dashboardFridgeChef.fridgeChef') };
}
export const dynamic = 'force-dynamic';

export default async function FridgeChefPage() {
  const t = await getTranslations();
  // Fridge Chef is part of Smart Kitchen (its only link is the kitchen
  // dashboard), so it carries that feature's plan gate; the API re-checks it.
  await requireFeature('/dashboard/kitchen');
  return (
    <div className="space-y-5">
      <PageHeader
        title={t('dashboardFridgeChef.fridgeChef')}
        description={t('fridgeChef.snapYourFridgeOrPantry')}
      />
      <FridgeChef />
    </div>
  );
}
