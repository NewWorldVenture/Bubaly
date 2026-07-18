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
  // Keep GraphModule available, but surface summary read failures and let the user retry.
  let reasoning: Awaited<ReturnType<typeof loadFamilyContext>> | null = null;
  let reasoningError = false;
  try {
    reasoning = await loadFamilyContext(supabase, ctx.active.familyId);
  } catch (error) {
    reasoningError = true;
    console.error('[dashboard-graph] reasoning context read failed', error);
  }

  return (
    <>
      {reasoningError && <GraphContextError />}
      {reasoning && reasoning.stats.entities > 0 && (
        <div className="mx-auto mb-4 max-w-5xl px-4">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-2xl border border-brand/20 bg-gradient-to-br from-brand/[0.07] to-surface/40 px-4 py-3">
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-brand/15 text-brand-text">
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

function GraphContextError() {
  return (
    <div className="mx-auto mb-4 max-w-5xl px-4">
      <div role="alert" className="rounded-2xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm">
        <p className="text-danger">Could not load the graph summary from Supabase.</p>
        <a href="/dashboard/graph" className="mt-2 inline-block font-medium text-danger underline">
          Retry graph summary
        </a>
      </div>
    </div>
  );
}
