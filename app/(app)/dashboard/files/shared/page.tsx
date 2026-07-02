import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { FilesHubModule } from '@/components/modules/files-hub-module';

export const metadata: Metadata = { title: 'Shared Files | Bubaly' };

export default async function SharedFilesPage() {
  await requireFeature('/dashboard/documents');
  return <FilesHubModule view="shared" />;
}
