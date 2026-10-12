import type { Metadata } from 'next';
import { Landmark } from 'lucide-react';
import { requireFeature } from '@/lib/supabase/auth';
import { requireAal2 } from '@/lib/auth/require-aal2';
import { isManager } from '@/lib/constants/roles';
import { EmptyState } from '@/components/ui/states';
import { TaxVaultModule } from '@/components/modules/tax-vault-module';
import { getTranslations } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.taxVault') };
}

export default async function TaxVaultPage() {
  const ctx = await requireFeature('/dashboard/tax-vault');
  // Tax documents are a parent's or adult's (the held 0508). Anyone else is
  // told so here, rather than shown a vault the database returns empty.
  if (!isManager(ctx.active.role)) {
    const t = await getTranslations();
    return <EmptyState icon={Landmark} title={t('taxVault.keptByParents')} description={t('taxVault.keptByParentsBody')} />;
  }
  await requireAal2(ctx, 'documents', '/dashboard/tax-vault');
  return <TaxVaultModule />;
}
