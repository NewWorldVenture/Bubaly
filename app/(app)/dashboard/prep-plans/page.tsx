import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { PlanningModule } from '@/components/modules/planning-module';
import { loadFamilyContext } from '@/lib/reasoning/context';
import { reasoningInsights } from '@/lib/reasoning/insights';
import { RelationshipInsights } from '@/components/reasoning/relationship-insights';
import { ErrorState } from '@/components/ui/states';

export const metadata: Metadata = { title: 'Prep Plans | Bubaly' };
export const dynamic = 'force-dynamic';

export default async function PrepPlansPage() {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  // R2: relationship reasoning next to the prep plans — a high-impact hub is worth
  // planning around. Keep the planner usable, but make a failed shared read visible.
  let reasoning: Awaited<ReturnType<typeof loadFamilyContext>> | null = null;
  let reasoningError = false;
  try {
    reasoning = await loadFamilyContext(supabase, ctx.active.familyId);
  } catch (error) {
    reasoningError = true;
    console.error('[dashboard/prep-plans] reasoning context read failed', error);
  }
  const insights = reasoning ? reasoningInsights(reasoning) : [];

  return (
    <>
      {reasoningError && (
        <div className="mx-auto mb-4 max-w-5xl px-4 pt-6">
          <ErrorState message="Relationship insights are temporarily unavailable from Supabase. Refresh and try again." />
        </div>
      )}
      {insights.length > 0 && (
        <div className="mx-auto mb-4 max-w-5xl px-4 pt-6">
          <RelationshipInsights insights={insights} />
        </div>
      )}
      <PlanningModule />
    </>
  );
}
