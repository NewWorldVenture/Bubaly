import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireFeature } from '@/lib/supabase/auth';
import { ClosetModule } from '@/components/modules/closet-module';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.closetOutfits') };
}

export default async function ClosetPage() {
  await requireFeature('/dashboard/closet');
  return <ClosetModule />;
}
