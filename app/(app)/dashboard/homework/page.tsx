import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { HomeworkModule } from '@/components/modules/homework-module';

export const metadata: Metadata = { title: 'Homework | Bubaly' };

export default async function HomeworkPage() {
  await requireFeature('/dashboard/homework');
  return <HomeworkModule />;
}
