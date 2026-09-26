import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext, isSuperAdmin } from '@/lib/supabase/auth';
import { KnowledgeBaseModule } from '@/components/modules/knowledge-base-module';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('knowledgeBase.familyKnowledgeBase') };
}

export default async function KnowledgePage() {
  await requireUserContext();
  const admin = await isSuperAdmin();
  return <KnowledgeBaseModule canSeed={admin} />;
}
