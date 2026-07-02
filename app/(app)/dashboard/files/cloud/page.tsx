import type { Metadata } from 'next';
import { requireFeature } from '@/lib/supabase/auth';
import { FilesHubModule } from '@/components/modules/files-hub-module';

export const metadata: Metadata = { title: 'Cloud Storage | Bubaly' };

export default async function CloudStoragePage() {
  await requireFeature('/dashboard/documents');
  return <FilesHubModule view="cloud" />;
}
