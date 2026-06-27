import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { SchoolModule } from '@/components/modules/school-module';

export const metadata: Metadata = { title: 'School Hub' };

export default async function SchoolPage() {
  await requireFeature('/dashboard/school');
  return <SchoolModule />;
}
