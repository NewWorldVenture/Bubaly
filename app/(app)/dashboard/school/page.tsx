import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { RelatedOutcomes } from '@/components/outcomes/related-outcomes';
import { requireFeature } from '@/lib/supabase/auth';
import { SchoolModule } from '@/components/modules/school-module';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.schoolHub') };
}

export default async function SchoolPage() {
  await requireFeature('/dashboard/school');
  return <><RelatedOutcomes href="/dashboard/school" /><SchoolModule /></>;
}
