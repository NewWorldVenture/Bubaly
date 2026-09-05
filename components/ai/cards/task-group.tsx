// Task group card: the tasks or chores a request produced or found, each with
// who has it and when it is due. Done rows stay visible but struck through,
// because "3 of 5 done" is the number a parent wants.
import { ListChecks } from 'lucide-react';
import type { TaskGroupCard } from '@/lib/ai/result-cards';
import { CardFrame, CardRow, MoreRow } from './index';

const COMPACT_ROWS = 4;
const FULL_ROWS = 12;

export function TaskGroupCardView({ card, compact = false, className }: { card: TaskGroupCard; compact?: boolean; className?: string }) {
  const rows = card.tasks.slice(0, compact ? COMPACT_ROWS : FULL_ROWS);
  const done = card.tasks.filter((t) => t.done).length;
  return (
    <CardFrame
      icon={ListChecks}
      title={card.title}
      subtitle={card.subtitle ?? (card.tasks.length ? `${done} of ${card.tasks.length} done` : null)}
      href={card.href}
      hrefLabel="Tasks"
      compact={compact}
      className={className}
    >
      {card.tasks.length === 0 ? (
        <p className="text-sm text-muted">Nothing on the list.</p>
      ) : (
        <ul className="divide-y divide-border/60">
          {rows.map((t, i) => (
            <CardRow
              key={t.id ?? `${t.title}-${i}`}
              label={t.title}
              done={t.done}
              detail={[t.assignee, t.due].filter(Boolean).join(' · ') || undefined}
            />
          ))}
          <MoreRow count={card.tasks.length - rows.length} />
        </ul>
      )}
    </CardFrame>
  );
}
