import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { KnowledgeBaseModule } from '@/components/modules/knowledge-base-module';

export const metadata: Metadata = { title: 'Family Knowledge Base | Bubaly' };

export default async function KnowledgePage() {
  await requireUserContext();
  return <KnowledgeBaseModule />;
}
