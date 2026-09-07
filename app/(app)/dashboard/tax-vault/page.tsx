import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { requireAal2 } from '@/lib/auth/require-aal2';
import { TaxVaultModule } from '@/components/modules/tax-vault-module';

export const metadata: Metadata = { title: 'Tax Vault' };

export default async function TaxVaultPage() {
  const ctx = await requireFeature('/dashboard/tax-vault');
  await requireAal2(ctx, 'documents', '/dashboard/tax-vault');
  return <TaxVaultModule />;
}
