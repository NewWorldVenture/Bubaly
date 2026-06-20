import type { Metadata } from 'next';
import { requirePlanLevel } from '@/lib/supabase/auth';
import { SchoolModule } from '@/components/modules/school-module';

export const metadata: Metadata = { title: 'School Hub' };

export default async function SchoolPage() {
  await requirePlanLevel(1);
  return <SchoolModule />;
}
