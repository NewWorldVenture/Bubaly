// Presentational card for R2 relationship insights (graph-backed reasoning).
// Server-compatible (no hooks) so pages can compute `reasoningInsights` and pass
// the rendered card straight into a client module as a node.
import Link from 'next/link';
import { Network, GitBranch, Zap, Link2Off } from 'lucide-react';
import type { ReasoningInsight, ReasoningInsightKind } from '@/lib/reasoning/insights';

const KIND_ICON: Record<ReasoningInsightKind, typeof Network> = {
  hub: GitBranch,
  ripple: Zap,
  coverage: Link2Off,
};

export function RelationshipInsights({ insights }: { insights: ReasoningInsight[] }) {
  if (insights.length === 0) return null;
  return (
    <div className="rounded-2xl border border-brand/20 bg-gradient-to-br from-brand/[0.07] to-surface/40 p-5">
      <div className="mb-3 flex items-center gap-2">
        <Network className="h-4 w-4 text-brand-text" />
        <span className="text-sm font-semibold uppercase tracking-wider text-fg">Relationships</span>
      </div>
      <ul className="space-y-2.5">
        {insights.map((i) => {
          const Icon = KIND_ICON[i.kind];
          return (
            <li key={i.id}>
              <Link href={i.href} className="flex items-start gap-3 rounded-xl border border-border bg-surface/50 p-3 transition hover:border-brand/40 hover:bg-elevated">
                <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-brand/15 text-brand-text">
                  <Icon className="h-3.5 w-3.5" />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-fg">{i.title}</span>
                  <span className="block text-xs text-muted">{i.detail}</span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
