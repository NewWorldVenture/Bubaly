import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { NutritionView } from '@/components/meals/nutrition-view';

export const metadata: Metadata = { title: 'Nutrition Tracker' };

export default async function NutritionPage() {
  await requireUserContext();
  return <NutritionView />;
}
