import type { Metadata } from 'next';
import { Brain } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { loadFamilyContext, contextSummary } from '@/lib/reasoning/context';
import { GraphModule } from '@/components/modules/graph-module';

export const metadata: Metadata = { title: 'Knowledge Graph | Bubaly' };
export const dynamic = 'force-dynamic';

export default async function GraphPage() {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  // R1: the unified reasoning context (graph + live snapshot + operating index).
  // Best-effort — degrades to an empty summary if the graph tables aren't there yet.
  const reasoning = await loadFamilyContext(supabase, ctx.active.familyId).catch(() => null);

  return (
    <>
      {reasoning && reasoning.stats.entities > 0 && (
        <div className="mx-auto mb-4 max-w-5xl px-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl border border-brand/20 bg-gradient-to-br from-brand/[0.07] to-surface/40 px-4 py-3">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-brand/15 text-brand">
              <Brain className="h-4 w-4" />
            </span>
            <p className="text-sm font-medium">{contextSummary(reasoning)}</p>
            {reasoning.orphanCount > 0 && (
              <span className="ml-auto rounded-full bg-amber-500/15 px-2.5 py-0.5 text-xs font-medium text-amber-500">
                {reasoning.orphanCount} unlinked
              </span>
            )}
          </div>
        </div>
      )}
      <GraphModule />
    </>
  );
}
