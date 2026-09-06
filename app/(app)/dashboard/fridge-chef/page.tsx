import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { PageHeader } from '@/components/app/page-header';
import { FridgeChef } from '@/components/meals/fridge-chef';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Fridge Chef | Bubaly' };
export const dynamic = 'force-dynamic';

export default async function FridgeChefPage() {
  const t = await getTranslations();
  // Gate to authenticated family members (the API re-checks auth + rate limits).
  await requireUserContext();
  return (
    <div className="space-y-5">
      <PageHeader
        title={t('dashboardFridgeChef.fridgeChef')}
        description="Snap your fridge or pantry — get allergy-aware dinner ideas and send what you're missing straight to your grocery list."
      />
      <FridgeChef />
    </div>
  );
}
