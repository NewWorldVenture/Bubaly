import type { Metadata } from 'next';
import { WalletModule } from '@/components/modules/wallet-module';

export const metadata: Metadata = { title: 'Family Wallet' };

export default function WalletPage() {
  return <WalletModule />;
}
