import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { requireAal2 } from '@/lib/auth/require-aal2';
import { FilesHubModule } from '@/components/modules/files-hub-module';

export const metadata: Metadata = { title: 'Shared Files | Bubaly' };

export default async function SharedFilesPage() {
  const ctx = await requireFeature('/dashboard/documents');
  await requireAal2(ctx, 'documents', '/dashboard/files/shared');
  return <FilesHubModule view="shared" />;
}
