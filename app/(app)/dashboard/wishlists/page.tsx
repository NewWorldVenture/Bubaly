import type { Metadata } from 'next';
import { RelatedOutcomes } from '@/components/outcomes/related-outcomes';
import { requireUserContext } from '@/lib/supabase/auth';
import { WishlistsModule } from '@/components/modules/wishlists-module';

export const metadata: Metadata = { title: 'Wish Lists | Bubaly' };

export default async function WishlistsPage() {
  await requireUserContext();
  return <><RelatedOutcomes href="/dashboard/wishlists" /><WishlistsModule /></>;
}
