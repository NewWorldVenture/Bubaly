import type { Metadata } from 'next';
import { requirePlanLevel } from '@/lib/supabase/auth';
import { HomeModule } from '@/components/modules/home-module';

export const metadata: Metadata = { title: 'Home & Maintenance' };

export default async function HomePage() {
  await requirePlanLevel(1);
  return <HomeModule />;
}
