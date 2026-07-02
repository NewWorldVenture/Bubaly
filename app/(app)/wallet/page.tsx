import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { WalletHub } from '@/components/wallet/wallet-hub';

export const metadata: Metadata = { title: 'My Wallet' };

export default async function WalletPage() {
  // Gate on auth/family membership; the hub fetches its own data (realtime) and
  // is scoped to the active family via RLS.
  await requireUserContext();
  return <WalletHub />;
}
