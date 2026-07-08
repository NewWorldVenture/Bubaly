// R5 — the proactive front door on Home. Renders "I already handled X · pending
// your OK: Y". Transparent (every item named + linked) and reversible (auto-handled
// items link to Autopilot where they can be undone). Server-compatible (no hooks).
import Link from 'next/link';
import { Sparkles, Check, BellRing, ChevronRight, RotateCcw } from 'lucide-react';
import type { FrontDoor } from '@/lib/home/front-door';

export function FrontDoorHero({ frontDoor }: { frontDoor: FrontDoor }) {
  if (!frontDoor.show) return null;
  const { headline, done, pending, doneCount, pendingCount } = frontDoor;

  return (
    <section className="rounded-2xl border border-brand/25 bg-gradient-to-br from-brand/[0.09] via-surface/40 to-surface/40 p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand/15 text-brand">
          <Sparkles className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold sm:text-base">{headline}</p>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {doneCount > 0 && (
              <div className="rounded-xl border border-border bg-surface/50 p-3">
                <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-emerald-500">
                  <Check className="h-3.5 w-3.5" /> Done for you
                </div>
                <ul className="space-y-1">
                  {done.slice(0, 3).map((d) => (
                    <li key={d.id} className="truncate text-sm text-fg">{d.title}</li>
                  ))}
                </ul>
                <Link href="/dashboard/autopilot" className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-muted transition hover:text-brand">
                  <RotateCcw className="h-3 w-3" /> Review or undo{doneCount > 3 ? ` (+${doneCount - 3} more)` : ''}
                </Link>
              </div>
            )}

            {pendingCount > 0 && (
              <div className="rounded-xl border border-border bg-surface/50 p-3">
                <div className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-amber-500">
                  <BellRing className="h-3.5 w-3.5" /> Waiting on you
                </div>
                <ul className="space-y-1">
                  {pending.slice(0, 3).map((p) => (
                    <li key={p.id} className="truncate text-sm text-fg">
                      {p.title}
                      {p.agent && <span className="ml-1 text-xs text-muted">· {p.agent}</span>}
                    </li>
                  ))}
                </ul>
                <Link href="/dashboard/inbox" className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-brand hover:underline">
                  Review &amp; approve{pendingCount > 3 ? ` (+${pendingCount - 3} more)` : ''} <ChevronRight className="h-3 w-3" />
                </Link>
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
