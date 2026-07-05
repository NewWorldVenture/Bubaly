import type { Metadata } from 'next';
import { requireUserContext, isSuperAdmin } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { KnowledgeBaseModule } from '@/components/modules/knowledge-base-module';
import { PlaybookInsights } from '@/components/playbook/playbook-insights';
import { loadPlaybookInsights } from '@/lib/playbook/server';

export const metadata: Metadata = { title: 'Family Knowledge Base | Bubaly' };
export const dynamic = 'force-dynamic';

export default async function KnowledgePage() {
  const ctx = await requireUserContext();
  const admin = await isSuperAdmin();
  const supabase = await createServer();
  const insights = await loadPlaybookInsights(supabase, ctx.active.familyId).catch(() => []);
  return (
    <>
      <PlaybookInsights insights={insights} />
      <KnowledgeBaseModule canSeed={admin} />
    </>
  );
}
