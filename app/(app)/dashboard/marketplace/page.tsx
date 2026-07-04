import type { Metadata } from 'next';
import { requireUserContext, isSuperAdmin } from '@/lib/supabase/auth';
import { MarketplaceModule } from '@/components/modules/marketplace-module';

export const metadata: Metadata = { title: 'Family Marketplace | Bubaly' };

export default async function MarketplacePage() {
  await requireUserContext();
  const admin = await isSuperAdmin();
  return <MarketplaceModule canSeed={admin} />;
}
