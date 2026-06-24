import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { CollegeModule } from '@/components/modules/college-module';

export const metadata: Metadata = { title: 'College & Scholarship Planner' };

export default async function CollegePage() {
  await requireUserContext();
  return <CollegeModule />;
}
