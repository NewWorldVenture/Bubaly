import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { TaxVaultModule } from '@/components/modules/tax-vault-module';

export const metadata: Metadata = { title: 'Tax Vault' };

export default async function TaxVaultPage() {
  await requireFeature('/dashboard/tax-vault');
  return <TaxVaultModule />;
}
