import type { Metadata } from 'next';
import { requirePlanLevel } from '@/lib/supabase/auth';
import { CareModule } from '@/components/modules/care-module';

export const metadata: Metadata = { title: 'Care Log | Bubaly' };

export default async function CarePage() {
  await requirePlanLevel(1);
  return <CareModule />;
}
