import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { DiscoverClient } from './discover-client';

export const metadata: Metadata = { title: 'Discover Recipes' };

export default async function DiscoverRecipesPage() {
  await requireUserContext();
  return <DiscoverClient />;
}
