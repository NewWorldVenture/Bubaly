// Shared "Since yesterday" recap card — the evening "what changed" narrative for
// the Family Operating Layer (north-star pillar #5). Presentational + server-safe
// (no 'use client'): it takes a computed ChangeSummary (from
// lib/operating-index/summary.ts `summarizeChange`) and renders it. Used by the
// Family Operating Index page, the Family Command Center, and the Daily Briefing
// so the same calm recap reads identically everywhere.

import { Moon, CheckCircle2, CircleDot, ArrowUpRight, ArrowDownRight } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import type { ChangeSummary } from '@/lib/operating-index/summary';

export function ChangeRecap({
  change,
  className,
  title = 'Since yesterday',
  showFirst = false,
}: {
  change: ChangeSummary;
  className?: string;
  title?: string;
  /** Render the gentle "first reading" line instead of nothing on day one. */
  showFirst?: boolean;
}) {
  // Calm by default: on the first-ever reading there's nothing to compare, so we
  // stay silent unless a surface explicitly asks to show the first-run line.
  if (change.isFirst && !showFirst) return null;

  const hasDetail =
    change.resolved.length > 0 || change.emerged.length > 0
    || change.improved.length > 0 || change.declined.length > 0;

  return (
    <section className={cn('rounded-2xl border border-border bg-surface/40 p-4 sm:p-5', className)}>
      <div className="mb-2 flex items-center gap-2">
        <Moon className="h-4 w-4 text-brand-text" />
        <h2 className="text-sm font-semibold">{title}</h2>
      </div>
      <p className="text-sm text-fg">{change.headline}</p>
      {hasDetail && (
        <div className="mt-3 grid gap-1.5 text-xs sm:grid-cols-2">
          {change.resolved.map((r) => (
            <div key={`r-${r.id}`} className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0" /> <span className="truncate">Cleared: {r.title}</span>
            </div>
          ))}
          {change.emerged.map((e) => (
            <div key={`e-${e.id}`} className="flex items-center gap-1.5 text-muted">
              <CircleDot className="h-3.5 w-3.5 shrink-0" /> <span className="truncate">New: {e.title}</span>
            </div>
          ))}
          {change.improved.map((d) => (
            <div key={`i-${d.id}`} className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
              <ArrowUpRight className="h-3.5 w-3.5 shrink-0" /> <span className="truncate">{d.label} +{d.delta}</span>
            </div>
          ))}
          {change.declined.map((d) => (
            <div key={`d-${d.id}`} className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
              <ArrowDownRight className="h-3.5 w-3.5 shrink-0" /> <span className="truncate">{d.label} {d.delta}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
