import type { Metadata } from 'next';
import { requirePlanLevel } from '@/lib/supabase/auth';
import { SportsModule } from '@/components/modules/sports-module';

export const metadata: Metadata = { title: 'Sports Hub' };

export default async function SportsPage() {
  await requirePlanLevel(1);
  return <SportsModule />;
}
