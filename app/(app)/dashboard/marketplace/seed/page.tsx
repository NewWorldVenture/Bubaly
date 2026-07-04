import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { requireUserContext, isSuperAdmin } from '@/lib/supabase/auth';
import { MarketplaceSeedScreen } from '@/components/marketplace/seed-screen';

export const metadata: Metadata = { title: 'Seed Marketplace | Bubaly' };

export default async function MarketplaceSeedPage() {
  await requireUserContext();
  // Raw SQL / test-seeding is an admin-only utility.
  if (!(await isSuperAdmin())) notFound();
  return <MarketplaceSeedScreen />;
}
