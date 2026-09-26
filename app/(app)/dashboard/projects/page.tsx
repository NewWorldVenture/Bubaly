import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireFeature } from '@/lib/supabase/auth';
import { ProjectsModule } from '@/components/modules/projects-module';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.homeProjects') };
}

export default async function ProjectsPage() {
  await requireFeature('/dashboard/projects');
  return <ProjectsModule />;
}
