import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { FilesHubModule } from '@/components/modules/files-hub-module';

export const metadata: Metadata = { title: 'Secure Vault | Bubaly' };

export default async function SecureVaultPage() {
  await requireFeature('/dashboard/documents');
  return <FilesHubModule view="vault" />;
}
