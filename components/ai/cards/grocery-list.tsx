// Grocery list card: what was added, grouped by aisle when the list is long
// enough to need it, plus what was skipped because it was already on the list
// or in the pantry — the reassurance that nothing was double-bought.
import { ShoppingCart } from 'lucide-react';
import type { GroceryListCard } from '@/lib/ai/result-cards';
import { CardFrame, CardRow, MoreRow } from './index';

const COMPACT_ROWS = 5;
const FULL_ROWS = 16;

export function GroceryListCardView({ card, compact = false, className }: { card: GroceryListCard; compact?: boolean; className?: string }) {
  const rows = card.items.slice(0, compact ? COMPACT_ROWS : FULL_ROWS);
  const notes = [
    card.skipped.length ? `${card.skipped.length} already on the list` : null,
    card.in_pantry.length ? `${card.in_pantry.length} in the pantry` : null,
  ].filter(Boolean).join(' · ');
  const byAisle = !compact && card.items.length > 6;
  const groups = byAisle
    ? [...rows.reduce((m, item) => {
      const key = item.category ?? 'Other';
      m.set(key, [...(m.get(key) ?? []), item]);
      return m;
    }, new Map<string, typeof rows>()).entries()]
    : [['', rows] as const];

  return (
    <CardFrame
      icon={ShoppingCart}
      title={card.title}
      subtitle={card.subtitle ?? (card.items.length ? `${card.items.length} ${card.items.length === 1 ? 'item' : 'items'}` : null)}
      href={card.href}
      hrefLabel="List"
      compact={compact}
      className={className}
      footer={notes || undefined}
    >
      {card.items.length === 0 ? (
        <p className="text-sm text-muted">{card.skipped.length || card.in_pantry.length ? 'Everything was already covered.' : 'The list is empty.'}</p>
      ) : (
        <div className="space-y-2">
          {groups.map(([aisle, items]) => (
            <div key={aisle}>
              {aisle && <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">{aisle}</p>}
              <ul className="divide-y divide-border/60">
                {items.map((item, i) => (
                  <CardRow key={`${item.name}-${i}`} label={item.name} done={item.checked} detail={item.quantity ?? undefined} />
                ))}
              </ul>
            </div>
          ))}
          <ul><MoreRow count={card.items.length - rows.length} /></ul>
        </div>
      )}
    </CardFrame>
  );
}
