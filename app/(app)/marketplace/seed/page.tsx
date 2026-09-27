import type { Metadata } from 'next';
import { requireUserContext, isSuperAdmin } from '@/lib/supabase/auth';
import { MarketplaceSeedScreen } from '@/components/marketplace/seed-screen';
import { AppNotFound } from '@/components/app/app-not-found';

export const metadata: Metadata = { title: 'Seed Marketplace' };

export default async function MarketplaceSeedPage() {
  await requireUserContext();
  // Raw SQL / test-seeding is an admin-only utility.
  if (!(await isSuperAdmin())) return <AppNotFound backHref="/marketplace" />;
  return <MarketplaceSeedScreen />;
}
