import type { Metadata } from 'next';
import { requirePlanLevel } from '@/lib/supabase/auth';
import { HomeworkModule } from '@/components/modules/homework-module';

export const metadata: Metadata = { title: 'Homework | Bubaly' };

export default async function HomeworkPage() {
  await requirePlanLevel(1);
  return <HomeworkModule />;
}
