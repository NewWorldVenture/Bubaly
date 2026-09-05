// Readiness card: one score a family can act on. The ring is the number,
// the factors say where the points went, and the recommendations are the
// order to fix things in — the paperwork risks first, because those have
// deadlines the trip does not move.
import { Gauge, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import type { ReadinessCard } from '@/lib/ai/result-cards';
import { CardFrame } from './index';

const COMPACT_RECS = 2;
const FULL_RECS = 5;

function scoreTone(score: number): 'success' | 'warning' | 'danger' {
  if (score >= 80) return 'success';
  if (score >= 50) return 'warning';
  return 'danger';
}

const RING: Record<'success' | 'warning' | 'danger', string> = {
  success: 'border-success text-success',
  warning: 'border-warning text-warning',
  danger: 'border-danger text-danger',
};

export function ReadinessCardView({ card, compact = false, className }: { card: ReadinessCard; compact?: boolean; className?: string }) {
  const tone = scoreTone(card.score);
  const recs = card.recommendations.slice(0, compact ? COMPACT_RECS : FULL_RECS);
  const risks = compact ? card.risks.slice(0, 1) : card.risks.slice(0, 4);
  const subtitle = card.subtitle
    ?? [card.level, card.days_until !== null ? (card.days_until <= 0 ? 'travelling now' : `${card.days_until} ${card.days_until === 1 ? 'day' : 'days'} to go`) : null].filter(Boolean).join(' · ');
  return (
    <CardFrame
      icon={Gauge}
      tone={tone}
      title={card.title}
      subtitle={subtitle || null}
      href={card.href}
      hrefLabel="Trip"
      compact={compact}
      className={className}
      aside={(
        <span
          role="meter"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(card.score)}
          aria-label="Readiness"
          className={cn('grid shrink-0 place-items-center rounded-full border-[3px] font-bold tabular-nums', compact ? 'h-11 w-11 text-sm' : 'h-14 w-14 text-base', RING[tone])}
        >
          {Math.round(card.score)}
        </span>
      )}
    >
      {!compact && card.factors.length > 0 && (
        <ul className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
          {card.factors.map((f) => (
            <li key={f.label} className="flex items-baseline justify-between gap-2 text-xs">
              <span className="truncate text-muted">{f.label}</span>
              <span className="tabular-nums">{Math.round(f.score)}</span>
            </li>
          ))}
        </ul>
      )}
      {risks.length > 0 && (
        <ul className={cn('space-y-1', !compact && card.factors.length > 0 && 'mt-3')}>
          {risks.map((r, i) => (
            <li key={`${r.title}-${i}`} className="flex items-start gap-2 rounded-xl bg-danger/5 px-3 py-2 text-sm">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden />
              <span className="min-w-0">
                <span className="block">{r.title}</span>
                {r.detail && !compact && <span className="block text-xs text-muted">{r.detail}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
      {recs.length > 0 && (
        <ol className={cn('list-decimal space-y-0.5 pl-5 text-sm', (risks.length > 0 || (!compact && card.factors.length > 0)) && 'mt-3')}>
          {recs.map((rec) => <li key={rec}>{rec}</li>)}
        </ol>
      )}
    </CardFrame>
  );
}
