import type { Metadata } from 'next';
import { RelatedOutcomes } from '@/components/outcomes/related-outcomes';
import { requireFeature } from '@/lib/supabase/auth';
import { MealsModule } from '@/components/modules/meals-module';

export const metadata: Metadata = { title: 'Meal Planning' };

export default async function MealsPage() {
  await requireFeature('/dashboard/meals');
  return <><RelatedOutcomes href="/dashboard/meals" /><MealsModule /></>;
}
