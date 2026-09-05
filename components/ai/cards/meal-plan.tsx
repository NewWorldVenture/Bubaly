// Meal plan card: the week as days, each day's slots as dishes. Compact shows
// dinners only (what a phone glance needs); full shows every slot and the
// "swap" follow-up so the plan can be adjusted from the card itself.
import { UtensilsCrossed } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import type { MealPlanCard } from '@/lib/ai/result-cards';
import { CardFrame, MoreRow } from './index';

const COMPACT_DAYS = 4;

function mealLabel(type: string): string {
  return type.charAt(0).toUpperCase() + type.slice(1);
}

export function MealPlanCardView({ card, compact = false, onAsk, className }: { card: MealPlanCard; compact?: boolean; onAsk?: (text: string) => void; className?: string }) {
  const days = compact ? card.days.slice(0, COMPACT_DAYS) : card.days;
  const hidden = card.days.length - days.length;
  const plannedCount = card.days.reduce((n, d) => n + d.meals.filter((m) => m.name).length, 0);
  const notes = [
    card.replaced ? `${card.replaced} replaced` : null,
    card.created_meals ? `${card.created_meals} new ${card.created_meals === 1 ? 'dish' : 'dishes'}` : null,
  ].filter(Boolean).join(' · ');

  return (
    <CardFrame
      icon={UtensilsCrossed}
      title={card.title}
      subtitle={card.subtitle ?? `${plannedCount} ${plannedCount === 1 ? 'meal' : 'meals'} planned`}
      href={card.href}
      hrefLabel="Meals"
      compact={compact}
      className={className}
      footer={notes || undefined}
    >
      {card.days.length === 0 ? (
        <p className="text-sm text-muted">Nothing is planned yet.</p>
      ) : (
        <ul className={cn('grid gap-1.5', compact ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-2')}>
          {days.map((day) => {
            const meals = compact ? day.meals.filter((m) => m.meal_type === 'dinner' || day.meals.length === 1) : day.meals;
            return (
              <li key={day.date} className="flex items-baseline gap-3 rounded-xl bg-bg/40 px-3 py-2">
                <span className="w-16 shrink-0 text-xs font-semibold text-muted">{day.label}</span>
                <div className="min-w-0 flex-1 space-y-0.5">
                  {(meals.length ? meals : day.meals).map((m, i) => (
                    <p key={`${m.meal_type}-${i}`} className="truncate text-sm">
                      {!compact && day.meals.length > 1 && <span className="text-muted">{mealLabel(m.meal_type)}: </span>}
                      {m.name ?? <span className="text-muted">open</span>}
                    </p>
                  ))}
                </div>
                {onAsk && !compact && (
                  <button
                    type="button"
                    onClick={() => onAsk(`Swap ${day.label}'s dinner for something else`)}
                    className="focus-ring coarse:min-h-11 shrink-0 rounded-lg px-2 py-1 text-xs font-medium text-brand-text hover:bg-elevated"
                  >
                    Swap
                  </button>
                )}
              </li>
            );
          })}
          <MoreRow count={hidden} />
        </ul>
      )}
    </CardFrame>
  );
}
