import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext, isSuperAdmin } from '@/lib/supabase/auth';
import { MarketplaceSeedScreen } from '@/components/marketplace/seed-screen';
import { AppNotFound } from '@/components/app/app-not-found';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('pageTitle.seedMarketplace') };
}

export default async function MarketplaceSeedPage() {
  await requireUserContext();
  // Raw SQL / test-seeding is an admin-only utility.
  if (!(await isSuperAdmin())) return <AppNotFound backHref="/marketplace" />;
  return <MarketplaceSeedScreen />;
}
