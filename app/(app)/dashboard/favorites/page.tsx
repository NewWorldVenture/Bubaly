import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { FavoritesView } from '@/components/meals/favorites-view';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.familyFavorites') };
}

export default async function FavoritesPage() {
  await requireUserContext();
  return <FavoritesView />;
}
