import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { ConciergeModule } from '@/components/modules/concierge-module';
import { loadFamilyContext } from '@/lib/reasoning/context';
import { reasoningInsights } from '@/lib/reasoning/insights';
import { RelationshipInsights } from '@/components/reasoning/relationship-insights';
import { ErrorState } from '@/components/ui/states';

export const metadata: Metadata = { title: 'AI Concierge' };
export const dynamic = 'force-dynamic';

export default async function ConciergePage() {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const supabase = await createServer();
  // R2: the concierge reasons over Knowledge Graph relationships. Keep the
  // primary module available, but make a failed shared read visible.
  let reasoning = null;
  let reasoningError = false;
  try {
    reasoning = await loadFamilyContext(supabase, ctx.active.familyId);
  } catch (error) {
    reasoningError = true;
    console.error('[dashboard/concierge] reasoning context read failed', error);
  }
  const insights = reasoning ? reasoningInsights(reasoning) : [];

  return (
    <>
      {reasoningError && (
        <div className="mx-auto mb-4 max-w-5xl px-4 pt-6">
          <ErrorState message={t('concierge.relationshipInsightsAreTemporarilyUnavailable')} />
        </div>
      )}
      {insights.length > 0 && (
        <div className="mx-auto mb-4 max-w-5xl px-4 pt-6">
          <RelationshipInsights insights={insights} />
        </div>
      )}
      <ConciergeModule />
    </>
  );
}
