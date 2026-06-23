import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { SportsModule } from '@/components/modules/sports-module';

export const metadata: Metadata = { title: 'Sports Hub' };

export default async function SportsPage() {
  await requireFeature('/dashboard/sports');
  return <SportsModule />;
}
