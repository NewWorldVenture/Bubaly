import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { RelatedOutcomes } from '@/components/outcomes/related-outcomes';
import { requireFeature } from '@/lib/supabase/auth';
import { MealsModule } from '@/components/modules/meals-module';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('featureCards.mealPlanning') };
}

export default async function MealsPage() {
  await requireFeature('/dashboard/meals');
  return <><RelatedOutcomes href="/dashboard/meals" /><MealsModule /></>;
}
