import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { MarketplaceModule } from '@/components/modules/marketplace-module';

export const metadata: Metadata = { title: 'Family Marketplace | Bubaly' };

export default async function MarketplacePage() {
  await requireUserContext();
  return <MarketplaceModule />;
}
