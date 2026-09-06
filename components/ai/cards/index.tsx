'use client';

// The result-card renderer (§53): one component per card kind, one dispatcher,
// and the frame they share. A card is the outcome a family reads — a plan, a
// conflict, a list, a score — never a tool name, an argument blob or a
// reasoning trail (§35, §37).
//
// Every card has a compact layout for the chat thread on a phone (fewer rows,
// tighter padding) and a full layout for the workspace's result pane; the
// `compact` prop flips between them, and the small-screen defaults are
// responsive on top of that so a full card on a phone still fits.
import type { ReactNode } from 'react';
import Link from 'next/link';
import { ArrowUpRight, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import type { ResultCard } from '@/lib/ai/result-cards';
import { MealPlanCardView } from './meal-plan';
import { CalendarConflictCardView } from './calendar-conflict';
import { BudgetAnalysisCardView } from './budget-analysis';
import { VacationPrepCardView } from './vacation-prep';
import { TaskGroupCardView } from './task-group';
import { GroceryListCardView } from './grocery-list';
import { ReadinessCardView } from './readiness';
import { SummaryCardView } from './summary';
import { ApprovalResultCardView } from './approval';
import { RunStatusCardView } from './run-status';
import { useTranslations } from '@/components/i18n/locale-provider';

export type CardTone = 'brand' | 'success' | 'warning' | 'danger' | 'neutral';

const TONE_ICON: Record<CardTone, string> = {
  brand: 'bg-brand/10 text-brand-text',
  success: 'bg-success/15 text-success',
  warning: 'bg-warning/15 text-warning',
  danger: 'bg-danger/15 text-danger',
  neutral: 'bg-elevated text-muted',
};

export type CardFrameProps = {
  icon: React.ComponentType<{ className?: string }>;
  tone?: CardTone;
  title: string;
  subtitle?: string | null;
  /** Deep link to the module that owns the data ("Open meals"). */
  href?: string | null;
  hrefLabel?: string;
  compact?: boolean;
  /** Extra content in the header row (a score, a badge). */
  aside?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
};

/** The shell every card kind renders inside, so ten kinds read as one system. */
export function CardFrame({ icon: Icon, tone = 'brand', title, subtitle, href, hrefLabel = 'Open', compact = false, aside, children, footer, className }: CardFrameProps) {
  return (
    <article className={cn('rounded-2xl border border-border bg-surface/60 text-fg', compact ? 'p-3' : 'p-4', className)}>
      <div className="flex items-start gap-3">
        <span className={cn('grid shrink-0 place-items-center rounded-xl', compact ? 'h-8 w-8' : 'h-9 w-9', TONE_ICON[tone])}>
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className={cn('font-semibold leading-tight', compact ? 'text-sm' : 'text-sm sm:text-base')}>{title}</h3>
          {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
        </div>
        {aside}
        {href && (
          <Link
            href={href}
            className="focus-ring coarse:min-h-11 inline-flex shrink-0 items-center gap-0.5 rounded-lg px-2 py-1 text-xs font-semibold text-brand-text hover:bg-elevated"
            aria-label={`${hrefLabel}: ${title}`}
          >
            {hrefLabel} <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        )}
      </div>
      {children && <div className={cn(compact ? 'mt-2' : 'mt-3')}>{children}</div>}
      {footer && <div className={cn('text-xs text-muted', compact ? 'mt-2' : 'mt-3')}>{footer}</div>}
    </article>
  );
}

/** A dotted list row used by several kinds — one line per thing, with an optional right-aligned detail. */
export function CardRow({ label, detail, muted = false, done = false, className }: { label: ReactNode; detail?: ReactNode; muted?: boolean; done?: boolean; className?: string }) {
  return (
    <li className={cn('flex items-baseline justify-between gap-3 py-1 text-sm', className)}>
      <span className={cn('min-w-0 truncate', muted && 'text-muted', done && 'line-through text-muted')}>{label}</span>
      {detail !== undefined && detail !== null && <span className="shrink-0 text-xs text-muted">{detail}</span>}
    </li>
  );
}

/** "+3 more" — every list caps so a card stays a card. */
export function MoreRow({ count }: { count: number }) {
  if (count <= 0) return null;
  return <li className="py-1 text-xs text-muted">+{count} more</li>;
}

export type ResultCardViewProps = {
  card: ResultCard;
  compact?: boolean;
  /** Whether the viewer may decide approvals (parent or adult). */
  canDecide?: boolean;
  /** Send a follow-up request from a card ("Swap Tuesday's dinner"). */
  onAsk?: (text: string) => void;
  className?: string;
};

/** Render any card by kind. Unknown kinds cannot reach here — `parseResultCard` drops them. */
export function ResultCardView({ card, compact = false, canDecide = false, onAsk, className }: ResultCardViewProps) {
  switch (card.kind) {
    case 'meal_plan': return <MealPlanCardView card={card} compact={compact} onAsk={onAsk} className={className} />;
    case 'calendar_conflict': return <CalendarConflictCardView card={card} compact={compact} onAsk={onAsk} className={className} />;
    case 'budget_analysis': return <BudgetAnalysisCardView card={card} compact={compact} className={className} />;
    case 'vacation_prep': return <VacationPrepCardView card={card} compact={compact} className={className} />;
    case 'task_group': return <TaskGroupCardView card={card} compact={compact} className={className} />;
    case 'grocery_list': return <GroceryListCardView card={card} compact={compact} className={className} />;
    case 'readiness': return <ReadinessCardView card={card} compact={compact} className={className} />;
    case 'summary': return <SummaryCardView card={card} compact={compact} className={className} />;
    case 'approval': return <ApprovalResultCardView card={card} compact={compact} canDecide={canDecide} className={className} />;
    case 'run_status': return <RunStatusCardView card={card} compact={compact} className={className} />;
  }
}

/** The placeholder while a turn is still producing its outcome. */
export function CardSkeleton({ compact = false, label = 'Bubaly is working on it…' }: { compact?: boolean; label?: string }) {
  return (
    <div role="status" aria-label={label} className={cn('rounded-2xl border border-border bg-surface/40', compact ? 'p-3' : 'p-4')}>
      <div className="flex items-center gap-3">
        <span className="grid h-9 w-9 place-items-center rounded-xl bg-brand/10 text-brand-text"><Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden /></span>
        <div className="flex-1 space-y-2">
          <div className="h-3.5 w-1/3 animate-pulse rounded bg-elevated/70 motion-reduce:animate-none" />
          <div className="h-3 w-1/2 animate-pulse rounded bg-elevated/70 motion-reduce:animate-none" />
        </div>
      </div>
      <p className="mt-3 text-xs text-muted">{label}</p>
    </div>
  );
}

/** A card that could not be shown — the text answer still stands, so this is quiet, not alarming. */
export function CardError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const t = useTranslations();
  return (
    <div role="alert" className="rounded-2xl border border-danger/30 bg-danger/5 px-4 py-3 text-sm text-danger">
      {message}
      {onRetry && (
        <button type="button" onClick={onRetry} className="focus-ring coarse:min-h-11 ml-2 font-medium underline">{t('index.tryAgain')}</button>
      )}
    </div>
  );
}
