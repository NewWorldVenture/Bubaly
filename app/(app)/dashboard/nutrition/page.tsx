import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { NutritionView } from '@/components/meals/nutrition-view';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.nutritionTracker') };
}

export default async function NutritionPage() {
  await requireUserContext();
  return <NutritionView />;
}
