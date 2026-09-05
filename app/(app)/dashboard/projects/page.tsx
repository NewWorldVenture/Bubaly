import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { ProjectsModule } from '@/components/modules/projects-module';

export const metadata: Metadata = { title: 'Home Projects' };

export default async function ProjectsPage() {
  await requireFeature('/dashboard/projects');
  return <ProjectsModule />;
}
