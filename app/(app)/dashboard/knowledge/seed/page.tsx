import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { notFound } from 'next/navigation';
import { requireUserContext, isSuperAdmin } from '@/lib/supabase/auth';
import { KnowledgeSeedScreen } from '@/components/knowledge/seed-screen';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('pageTitle.seedKnowledgeBase') };
}

export default async function KnowledgeSeedPage() {
  await requireUserContext();
  if (!(await isSuperAdmin())) notFound();
  return <KnowledgeSeedScreen />;
}
