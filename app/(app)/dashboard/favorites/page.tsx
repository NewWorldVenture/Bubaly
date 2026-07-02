import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { FavoritesView } from '@/components/meals/favorites-view';

export const metadata: Metadata = { title: 'Family Favorites' };

export default async function FavoritesPage() {
  await requireUserContext();
  return <FavoritesView />;
}
