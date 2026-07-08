import type { Metadata } from 'next';
import Link from 'next/link';
import {
  Compass, Check, ArrowRight, AlertTriangle, HelpCircle, Vote, Bot, Users, Rocket,
} from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { PageHeader } from '@/components/app/page-header';
import { loadAndSnapshotReasoning } from '@/lib/reasoning/engine-server';
import type { ReasoningQuestionId } from '@/lib/reasoning/engine';
import { cn } from '@/lib/utils/cn';

export const metadata: Metadata = { title: 'Family Reasoning' };
export const dynamic = 'force-dynamic';

const Q_ICON: Record<ReasoningQuestionId, React.ComponentType<{ className?: string }>> = {
  matters_most: AlertTriangle,
  forgotten: HelpCircle,
  decide_next: Vote,
  auto_complete: Bot,
  who_needs_help: Users,
  what_next: Rocket,
};

// The one Family Reasoning Engine (R7). A single core answers the six questions
// every surface consumes — composed live from the Operating Index orchestrator,
// the graph reasoning insights (R2), and the hard signals (R10). One report,
// persisted once a day so the family can watch the trend.
export default async function ReasoningPage() {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const report = await loadAndSnapshotReasoning(supabase, ctx.active.familyId, ctx.user.id);

  const attention = report.answers.filter((a) => a.status === 'attention').length;

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:px-6">
      <PageHeader
        title="Family Reasoning"
        description="One engine, six questions. Bubaly reasons across your calendar, decisions, signals and graph to answer what matters, what’s slipping, and what to do next."
      />

      <section className="mb-5 rounded-2xl border border-border bg-surface/60 p-5">
        <div className="flex items-center gap-2.5">
          <Compass className="h-5 w-5 text-brand" />
          {report.allClear ? (
            <p className="text-sm text-fg">
              <span className="font-medium">All clear.</span> Nothing needs the family right now — you’re in good shape.
            </p>
          ) : (
            <p className="text-sm text-fg">
              <span className="font-medium">{attention} of 6</span> areas need your attention this week.
            </p>
          )}
          {report.allClear && (
            <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-emerald-500/12 px-2 py-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
              <Check className="h-3 w-3" /> All clear
            </span>
          )}
        </div>
      </section>

      <div className="grid gap-2.5 sm:grid-cols-2">
        {report.answers.map((a) => {
          const Icon = Q_ICON[a.id];
          const attn = a.status === 'attention';
          return (
            <section
              key={a.id}
              className={cn(
                'rounded-xl border p-4',
                attn ? 'border-brand/25 bg-brand/[0.04]' : 'border-border bg-surface/40',
              )}
            >
              <div className="mb-1.5 flex items-start gap-2">
                <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', attn ? 'text-brand' : 'text-muted')} />
                <div className="min-w-0">
                  <p className="text-xs font-medium text-muted">{a.question}</p>
                  <p className={cn('text-sm', attn ? 'font-medium text-fg' : 'text-muted')}>{a.headline}</p>
                </div>
              </div>
              {a.items.length > 0 && (
                <ul className="mt-2 space-y-1.5 pl-6">
                  {a.items.map((it, i) => (
                    <li key={i} className="text-xs">
                      {it.href ? (
                        <Link href={it.href} className="inline-flex items-center gap-1 text-muted hover:text-brand">
                          <span className="font-medium text-fg">{it.title}</span>
                          <ArrowRight className="h-3 w-3" />
                        </Link>
                      ) : (
                        <span className="font-medium text-fg">{it.title}</span>
                      )}
                      {it.detail && <span className="ml-1 text-muted">— {it.detail}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>

      <p className="mt-5 text-center text-[11px] text-muted">
        Reasoned live across your family’s data — the Operating Index, decisions, hard signals and knowledge graph.
        Saved once a day so you can watch the trend.
      </p>
    </div>
  );
}
