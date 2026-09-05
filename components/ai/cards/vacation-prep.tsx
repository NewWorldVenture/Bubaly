// Vacation preparation card: where and when, what is in place and what still
// clashes or needs doing, and the next steps — the trip's checklist as a card.
import { Check, Circle, Plane } from 'lucide-react';
import type { VacationPrepCard } from '@/lib/ai/result-cards';
import { CardFrame, MoreRow } from './index';

const COMPACT_ROWS = 4;
const FULL_ROWS = 10;

export function VacationPrepCardView({ card, compact = false, className }: { card: VacationPrepCard; compact?: boolean; className?: string }) {
  const items = card.items.slice(0, compact ? COMPACT_ROWS : FULL_ROWS);
  const subtitle = card.subtitle ?? ([card.destination, card.dates].filter(Boolean).join(' · ') || null);
  return (
    <CardFrame
      icon={Plane}
      title={card.title}
      subtitle={subtitle}
      href={card.href}
      hrefLabel="Trip"
      compact={compact}
      className={className}
      footer={!compact && card.next_steps.length > 0 ? (
        <ul className="space-y-0.5">
          {card.next_steps.map((step) => <li key={step}>Next: {step}</li>)}
        </ul>
      ) : undefined}
    >
      {items.length === 0 ? (
        <p className="text-sm text-muted">Nothing to prepare yet.</p>
      ) : (
        <ul className="space-y-1">
          {items.map((item, i) => (
            <li key={`${item.label}-${i}`} className="flex items-start gap-2 text-sm">
              {item.done
                ? <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-label="Done" />
                : <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-label="Open" />}
              <span className="min-w-0 flex-1">
                <span className="block truncate">{item.label}</span>
                {item.detail && <span className="block text-xs text-muted">{item.detail}</span>}
              </span>
            </li>
          ))}
          <MoreRow count={card.items.length - items.length} />
        </ul>
      )}
    </CardFrame>
  );
}
