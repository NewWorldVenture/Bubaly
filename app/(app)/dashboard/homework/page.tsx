import type { Metadata } from 'next';
import { requirePlanLevel } from '@/lib/supabase/auth';
import { HomeworkModule } from '@/components/modules/homework-module';

export const metadata: Metadata = { title: 'Homework | FamilyOS' };

export default async function HomeworkPage() {
  await requirePlanLevel(1);
  return <HomeworkModule />;
}
