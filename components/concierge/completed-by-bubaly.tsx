// §16 "Completed By Bubaly": recent outcomes — finished runs and the specialist
// agents' completed actions — as a short list of what got done, each linking
// to where the result lives. No hooks: the server page renders it from rows it
// already has, and a partial run is labelled as partial rather than dressed up.
import Link from 'next/link';
import { CheckCircle2, ChevronRight, AlertTriangle } from 'lucide-react';
import type { CompletedItem } from '@/lib/home/today';
import { cn } from '@/lib/utils/cn';

function whenLabel(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  if (days <= 0) return new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (days === 1) return 'Yesterday';
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function CompletedByBubaly({ items, className }: { items: CompletedItem[]; className?: string }) {
  return (
    <section aria-labelledby="completed-by-heading" className={className}>
      <div className="mb-3 flex items-center gap-2">
        <CheckCircle2 className="h-4 w-4 text-success" aria-hidden />
        <h2 id="completed-by-heading" className="text-sm font-semibold uppercase tracking-wide text-muted">Completed by Bubaly</h2>
      </div>
      {items.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-border px-4 py-5 text-center text-sm text-muted">
          Nothing finished yet. The first thing Bubaly completes for your family lands here.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {items.map((item) => (
            <li key={item.key}>
              <Link
                href={item.href}
                className="flex min-h-[44px] items-center gap-3 rounded-xl border border-border/60 bg-surface/20 px-4 py-2.5 transition hover:bg-elevated focus-ring"
              >
                {item.partial
                  ? <AlertTriangle className="h-4 w-4 shrink-0 text-warning" aria-label="Partly done" />
                  : <CheckCircle2 className="h-4 w-4 shrink-0 text-success" aria-hidden />}
                <div className="min-w-0 flex-1">
                  <p className={cn('truncate text-sm', item.partial ? 'text-fg' : 'text-fg/90')}>{item.title}</p>
                  {item.detail && <p className="truncate text-xs text-muted">{item.detail}</p>}
                </div>
                <span className="shrink-0 text-xs text-muted">{whenLabel(item.at)}</span>
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
