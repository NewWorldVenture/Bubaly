import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { ReunionModule } from '@/components/modules/reunion-module';

export const metadata: Metadata = { title: 'Family Reunion Planner' };

export default async function ReunionsPage() {
  await requireUserContext();
  return <ReunionModule />;
}
