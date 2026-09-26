import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { FamilyTreeModule } from '@/components/modules/family-tree-module';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.familyTree') };
}

export default async function FamilyTreePage() {
  await requireUserContext();
  return <FamilyTreeModule />;
}
