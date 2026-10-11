import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { refuseGuest } from '@/lib/auth/guest-scope';
import { WalletHub } from '@/components/wallet/wallet-hub';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.myWallet') };
}

export default async function WalletPage() {
  // Gate on auth/family membership; the hub fetches its own data (realtime) and
  // is scoped to the active family via RLS.
  refuseGuest(await requireUserContext(), '/wallet');
  return <WalletHub />;
}
