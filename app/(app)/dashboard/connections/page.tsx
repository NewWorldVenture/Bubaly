import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { ConnectionsModule } from '@/components/modules/connections-module';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.connections') };
}

export default async function ConnectionsPage() {
  await requireUserContext();
  return <ConnectionsModule />;
}
