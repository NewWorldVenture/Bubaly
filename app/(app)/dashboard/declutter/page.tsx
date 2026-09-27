import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireFeature } from '@/lib/supabase/auth';
import { DeclutterModule } from '@/components/modules/declutter-module';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.declutterMissions') };
}

export default async function DeclutterPage() {
  await requireFeature('/dashboard/declutter');
  return <DeclutterModule />;
}
