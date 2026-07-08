import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { PlanningModule } from '@/components/modules/planning-module';
import { loadFamilyContext } from '@/lib/reasoning/context';
import { reasoningInsights } from '@/lib/reasoning/insights';
import { RelationshipInsights } from '@/components/reasoning/relationship-insights';

export const metadata: Metadata = { title: 'Prep Plans | Bubaly' };
export const dynamic = 'force-dynamic';

export default async function PrepPlansPage() {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  // R2: relationship reasoning next to the prep plans — a high-impact hub is worth
  // planning around. Best-effort; a missing graph renders nothing.
  const reasoning = await loadFamilyContext(supabase, ctx.active.familyId).catch(() => null);
  const insights = reasoning ? reasoningInsights(reasoning) : [];

  return (
    <>
      {insights.length > 0 && (
        <div className="mx-auto mb-4 max-w-5xl px-4 pt-6">
          <RelationshipInsights insights={insights} />
        </div>
      )}
      <PlanningModule />
    </>
  );
}
