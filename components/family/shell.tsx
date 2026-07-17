// Presentational building blocks shared by every Bubaly module page.
// Server-safe (no client hooks) so pages stay server components.
import Link from 'next/link';
import { ArrowRight, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

export function StatTile({
  label, value, icon: Icon, accent = 'bg-violet-600', href, sublabel,
}: {
  label: string; value: string | number; icon: React.ComponentType<{ className?: string }>;
  accent?: string; href?: string; sublabel?: string;
}) {
  const inner = (
    <>
      <div className="flex items-center gap-3">
        <div className={cn('grid h-11 w-11 shrink-0 place-items-center rounded-xl', accent)}>
          <Icon className="h-5 w-5 text-white" />
        </div>
        <div className="min-w-0">
          <p className="text-2xl font-bold leading-none tabular-nums">{value}</p>
          <p className="mt-0.5 truncate text-xs text-muted">{label}</p>
        </div>
      </div>
      {sublabel && <p className="mt-3 text-xs font-semibold text-brand-text">{sublabel} →</p>}
    </>
  );
  const klass = 'flex flex-col rounded-2xl border border-border bg-surface/40 p-5 transition hover:bg-elevated';
  return href ? <Link href={href} className={klass}>{inner}</Link> : <div className={klass}>{inner}</div>;
}

export function SectionCard({
  title, description, action, viewAllHref, children, className,
}: {
  title: string; description?: string; action?: React.ReactNode;
  viewAllHref?: string; children: React.ReactNode; className?: string;
}) {
  return (
    <section className={cn('rounded-2xl border border-border bg-surface/40 p-5', className)}>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-semibold">{title}</h2>
          {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {action}
          {viewAllHref && (
            <Link href={viewAllHref} className="inline-flex items-center gap-1 text-xs font-semibold text-brand-text">
              View all <ArrowRight className="h-3 w-3" />
            </Link>
          )}
        </div>
      </div>
      {children}
    </section>
  );
}

export function MiniEmpty({ icon: Icon, text }: { icon: React.ComponentType<{ className?: string }>; text: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-10 text-center">
      <Icon className="h-8 w-8 text-muted/30" />
      <p className="mt-2 text-sm text-muted/60">{text}</p>
    </div>
  );
}

/**
 * Server-safe error surface for a section whose read FAILED — distinct from
 * MiniEmpty (which means "genuinely no data yet"). Showing MiniEmpty on a failed
 * read is a false-empty: it tells the operator "0 rows" when the query errored.
 * SSR-only (no client handler); the user retries by reloading the page.
 */
export function MiniError({
  text = 'Couldn’t load this data. Refresh to try again.',
}: {
  text?: string;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center rounded-xl border border-danger/30 bg-danger/5 py-10 text-center"
    >
      <AlertTriangle className="h-8 w-8 text-danger/70" />
      <p className="mt-2 text-sm text-danger">{text}</p>
    </div>
  );
}

const LEVEL_STYLE: Record<string, string> = {
  high: 'text-rose-300 bg-rose-500/15',
  elevated: 'text-orange-300 bg-orange-500/15',
  moderate: 'text-amber-300 bg-amber-500/15',
  low: 'text-emerald-300 bg-emerald-500/15',
};

export function LevelBadge({ level }: { level: string }) {
  return (
    <span className={cn('rounded-full px-2.5 py-0.5 text-xs font-bold capitalize', LEVEL_STYLE[level] ?? LEVEL_STYLE.low)}>
      {level}
    </span>
  );
}

/** Circular progress ring (server-safe SVG) for completion / scores. */
export function ScoreRing({ pct, label, size = 128 }: { pct: number; label?: string; size?: number }) {
  const r = 40;
  const circ = 2 * Math.PI * r;
  return (
    <div className="relative shrink-0" style={{ height: size, width: size }}>
      <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90">
        <circle cx="50" cy="50" r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="12" />
        <circle cx="50" cy="50" r={r} fill="none" stroke="url(#ring-grad)" strokeWidth="12"
          strokeDasharray={`${(circ * pct) / 100} ${circ}`} strokeLinecap="round" />
        <defs>
          <linearGradient id="ring-grad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#7c5dff" /><stop offset="100%" stopColor="#3b82f6" />
          </linearGradient>
        </defs>
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-2xl font-black tabular-nums">{pct}%</span>
        {label && <span className="text-[10px] text-muted">{label}</span>}
      </div>
    </div>
  );
}
