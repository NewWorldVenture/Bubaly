import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { DiscoverClient } from './discover-client';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('dashboardRecipesDiscoverDiscoverClient.discoverRecipes') };
}

export default async function DiscoverRecipesPage() {
  await requireUserContext();
  return <DiscoverClient />;
}
