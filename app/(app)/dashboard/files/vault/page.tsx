import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireFeature } from '@/lib/supabase/auth';
import { requireAal2 } from '@/lib/auth/require-aal2';
import { FilesHubModule } from '@/components/modules/files-hub-module';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: `${t('filesHubModule.vaultTitle')} | Bubaly` };
}

export default async function SecureVaultPage() {
  const ctx = await requireFeature('/dashboard/documents');
  await requireAal2(ctx, 'documents', '/dashboard/files/vault');
  return <FilesHubModule view="vault" />;
}
