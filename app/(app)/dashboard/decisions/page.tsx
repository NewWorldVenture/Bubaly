import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { DecisionsModule } from '@/components/modules/decisions-module';
import { loadFamilyContext } from '@/lib/reasoning/context';
import { reasoningInsights } from '@/lib/reasoning/insights';
import { RelationshipInsights } from '@/components/reasoning/relationship-insights';

export const metadata: Metadata = { title: 'Decision Engine | Bubaly' };
export const dynamic = 'force-dynamic';

export default async function DecisionsPage() {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  // R2: surface Knowledge Graph relationship context alongside the decision tool —
  // what's centrally connected is worth weighing when you decide. Best-effort.
  const reasoning = await loadFamilyContext(supabase, ctx.active.familyId).catch(() => null);
  const insights = reasoning ? reasoningInsights(reasoning) : [];

  return (
    <>
      {insights.length > 0 && (
        <div className="mx-auto mb-4 max-w-5xl px-4 pt-6">
          <RelationshipInsights insights={insights} />
        </div>
      )}
      <DecisionsModule />
    </>
  );
}
