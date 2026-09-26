import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { RelationshipModule } from '@/components/modules/relationship-module';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.relationshipHelper') };
}

export default async function RelationshipPage() {
  await requireUserContext();
  return <RelationshipModule />;
}
