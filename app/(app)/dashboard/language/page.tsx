import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireFeature } from '@/lib/supabase/auth';
import { LanguageModule } from '@/components/modules/language-module';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.languagePractice') };
}

export default async function LanguagePage() {
  await requireFeature('/dashboard/language');
  return <LanguageModule />;
}
