import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { PlanningModule } from '@/components/modules/planning-module';

export const metadata: Metadata = { title: 'Prep Plans | Bubaly' };

export default async function PrepPlansPage() {
  await requireUserContext();
  return <PlanningModule />;
}
