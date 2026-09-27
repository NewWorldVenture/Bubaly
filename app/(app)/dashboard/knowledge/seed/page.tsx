import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext, isSuperAdmin } from '@/lib/supabase/auth';
import { KnowledgeSeedScreen } from '@/components/knowledge/seed-screen';
import { AppNotFound } from '@/components/app/app-not-found';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('pageTitle.seedKnowledgeBase') };
}

export default async function KnowledgeSeedPage() {
  await requireUserContext();
  if (!(await isSuperAdmin())) return <AppNotFound backHref="/dashboard" />;
  return <KnowledgeSeedScreen />;
}
