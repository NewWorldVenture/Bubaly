import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { RelatedOutcomes } from '@/components/outcomes/related-outcomes';
import { requireUserContext } from '@/lib/supabase/auth';
import { WishlistsModule } from '@/components/modules/wishlists-module';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.wishLists') };
}

export default async function WishlistsPage() {
  await requireUserContext();
  return <><RelatedOutcomes href="/dashboard/wishlists" /><WishlistsModule /></>;
}
