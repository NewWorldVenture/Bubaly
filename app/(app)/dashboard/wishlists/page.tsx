import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { WishlistsModule } from '@/components/modules/wishlists-module';

export const metadata: Metadata = { title: 'Wish Lists | Bubaly' };

export default async function WishlistsPage() {
  await requireUserContext();
  return <WishlistsModule />;
}
