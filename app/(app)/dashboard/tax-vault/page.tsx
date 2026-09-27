import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { requireAal2 } from '@/lib/auth/require-aal2';
import { TaxVaultModule } from '@/components/modules/tax-vault-module';
import { getTranslations } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('navLabel.taxVault') };
}

export default async function TaxVaultPage() {
  const ctx = await requireFeature('/dashboard/tax-vault');
  await requireAal2(ctx, 'documents', '/dashboard/tax-vault');
  const t = await getTranslations();
  return (
    <>
      {/* The module draws no heading of its own; this names the page for assistive technology (MAIN-F-D05). */}
      <h1 className="sr-only">{t('taxVault.pageTitle')}</h1>
      <TaxVaultModule />
    </>
  );
}
