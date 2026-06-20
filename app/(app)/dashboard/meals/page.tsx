import type { Metadata } from 'next';
import { requirePlanLevel } from '@/lib/supabase/auth';
import { MealsModule } from '@/components/modules/meals-module';

export const metadata: Metadata = { title: 'Meal Planning' };

export default async function MealsPage() {
  await requirePlanLevel(1);
  return <MealsModule />;
}
