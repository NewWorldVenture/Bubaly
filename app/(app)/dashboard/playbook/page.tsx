import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { PlaybookModule } from '@/components/modules/playbook-module';
import { loadFamilyContext } from '@/lib/reasoning/context';
import { reasoningInsights } from '@/lib/reasoning/insights';
import { RelationshipInsights } from '@/components/reasoning/relationship-insights';
import { ErrorState } from '@/components/ui/states';

export const metadata: Metadata = { title: 'Family Playbook | Bubaly' };
export const dynamic = 'force-dynamic';

export default async function PlaybookPage() {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const supabase = await createServer();
  // R2: the playbook learns preferences; the graph shows how they connect.
  // Shared-read failures stay visible while the primary playbook remains usable.
  let reasoning = null;
  let reasoningError = false;
  try {
    reasoning = await loadFamilyContext(supabase, ctx.active.familyId);
  } catch (error) {
    reasoningError = true;
    console.error('[dashboard/playbook] reasoning context read failed', error);
  }
  const insights = reasoning ? reasoningInsights(reasoning) : [];

  return (
    <>
      {reasoningError && (
        <div className="mx-auto mb-4 max-w-5xl px-4 pt-6">
          <ErrorState message={t('playbook.relationshipInsightsAreTemporarilyUnavailable')} />
        </div>
      )}
      {insights.length > 0 && (
        <div className="mx-auto mb-4 max-w-5xl px-4 pt-6">
          <RelationshipInsights insights={insights} />
        </div>
      )}
      <PlaybookModule />
    </>
  );
}
