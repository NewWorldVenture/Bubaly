import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { CelebrationsModule } from '@/components/modules/celebrations-module';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.celebrations') };
}

export default async function CelebrationsPage() {
  await requireUserContext();
  return <CelebrationsModule />;
}
