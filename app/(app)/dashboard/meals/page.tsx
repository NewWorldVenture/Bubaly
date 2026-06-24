import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { MealsModule } from '@/components/modules/meals-module';

export const metadata: Metadata = { title: 'Meal Planning' };

export default async function MealsPage() {
  await requireFeature('/dashboard/meals');
  return <MealsModule />;
}
