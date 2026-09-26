import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { FamilyModule } from '@/components/modules/family-module';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.family') };
}

export default function FamilyPage() {
  return <FamilyModule />;
}
