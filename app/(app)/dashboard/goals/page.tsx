import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireFeature } from '@/lib/supabase/auth';
import { GoalsModule } from '@/components/modules/goals-module';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('childDetail.goals') };
}

export default async function GoalsPage() {
  await requireFeature('/dashboard/goals');
  return <GoalsModule />;
}
