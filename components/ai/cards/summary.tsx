// Summary card: the default for structured output no richer card claims — a
// few facts a person can read and the first list of named things. Ids never
// reach it (`summaryCardFromData` strips them), so it reads as an outcome.
import { Sparkles } from 'lucide-react';
import type { SummaryCard } from '@/lib/ai/result-cards';
import { CardFrame, CardRow, MoreRow } from './index';

const COMPACT_FACTS = 3;
const COMPACT_ITEMS = 4;

export function SummaryCardView({ card, compact = false, className }: { card: SummaryCard; compact?: boolean; className?: string }) {
  const facts = compact ? card.facts.slice(0, COMPACT_FACTS) : card.facts;
  const items = compact ? card.items.slice(0, COMPACT_ITEMS) : card.items;
  return (
    <CardFrame
      icon={Sparkles}
      title={card.title}
      subtitle={card.subtitle}
      href={card.href}
      compact={compact}
      className={className}
      footer={card.note ?? undefined}
    >
      {facts.length > 0 && (
        <dl className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
          {facts.map((f) => (
            <div key={f.label} className="flex items-baseline justify-between gap-3 text-sm">
              <dt className="truncate text-muted">{f.label}</dt>
              <dd className="truncate text-right">{f.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {items.length > 0 && (
        <ul className={facts.length > 0 ? 'mt-2 divide-y divide-border/60' : 'divide-y divide-border/60'}>
          {items.map((item, i) => <CardRow key={`${item}-${i}`} label={item} />)}
          <MoreRow count={card.items.length - items.length} />
        </ul>
      )}
    </CardFrame>
  );
}
