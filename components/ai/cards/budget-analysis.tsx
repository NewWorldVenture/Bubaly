// Budget analysis card: the total, the headline insight, and a bar per
// category — against its limit when there is one, against the total when the
// card is a spending breakdown, with the change when it is a comparison.
import { Wallet } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { formatMoney, type BudgetAnalysisCard } from '@/lib/ai/result-cards';
import { CardFrame, MoreRow } from './index';

const COMPACT_ROWS = 3;
const FULL_ROWS = 8;

export function BudgetAnalysisCardView({ card, compact = false, className }: { card: BudgetAnalysisCard; compact?: boolean; className?: string }) {
  const rows = card.rows.slice(0, compact ? COMPACT_ROWS : FULL_ROWS);
  const total = formatMoney(card.total_spent, card.currency);
  const headline = card.total_limit !== null
    ? `${total} of ${formatMoney(card.total_limit, card.currency)}`
    : card.previous_total !== null && card.previous_total !== undefined
      ? `${total} vs ${formatMoney(card.previous_total, card.currency)} before`
      : total;
  const overBudget = card.total_limit !== null && card.total_spent > card.total_limit;

  return (
    <CardFrame
      icon={Wallet}
      tone={overBudget || card.rows.some((r) => r.over && r.limit !== null) ? 'warning' : 'brand'}
      title={card.title}
      subtitle={card.subtitle ?? card.period ?? null}
      href={card.href}
      hrefLabel="Budgets"
      compact={compact}
      className={className}
      aside={<span className={cn('shrink-0 text-sm font-semibold tabular-nums', overBudget ? 'text-danger' : 'text-fg')}>{headline}</span>}
      footer={card.insight ?? undefined}
    >
      {rows.length > 0 && (
        <ul className="space-y-1.5">
          {rows.map((r) => {
            const pct = r.limit ? Math.min(100, Math.round((r.spent / r.limit) * 100)) : r.share !== null ? Math.min(100, Math.round(r.share)) : null;
            const detail = r.limit !== null
              ? `${formatMoney(r.spent, card.currency)} / ${formatMoney(r.limit, card.currency)}`
              : r.delta !== null
                ? `${formatMoney(r.spent, card.currency)} (${r.delta > 0 ? '+' : r.delta < 0 ? '−' : ''}${formatMoney(Math.abs(r.delta), card.currency)})`
                : `${formatMoney(r.spent, card.currency)}${r.share !== null ? ` · ${Math.round(r.share)}%` : ''}`;
            return (
              <li key={r.label}>
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className={cn('min-w-0 truncate', r.over && 'text-danger')}>{r.label}</span>
                  <span className="shrink-0 text-xs tabular-nums text-muted">{detail}</span>
                </div>
                {pct !== null && (
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-elevated" aria-hidden>
                    <div className={cn('h-full rounded-full', r.over ? 'bg-danger' : 'bg-brand')} style={{ width: `${pct}%` }} />
                  </div>
                )}
              </li>
            );
          })}
          <MoreRow count={card.rows.length - rows.length} />
        </ul>
      )}
    </CardFrame>
  );
}
