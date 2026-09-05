import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { CareerModule } from '@/components/modules/career-module';

export const metadata: Metadata = { title: 'Career Hub' };

export default async function CareerPage() {
  await requireFeature('/dashboard/career');
  return <CareerModule />;
}
