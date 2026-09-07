// Calendar conflict card: "soccer and the dentist overlap Saturday at 10:00"
// — one row per double-booking, who it affects, and a one-tap way to ask
// Bubaly to move one of them. No conflicts is good news and says so.
import { CalendarX2, CheckCircle2 } from 'lucide-react';
import { useTranslations } from '@/components/i18n/locale-provider';
import type { CalendarConflictCard } from '@/lib/ai/result-cards';
import { CardFrame, MoreRow } from './index';

const COMPACT_ROWS = 3;

export function CalendarConflictCardView({ card, compact = false, onAsk, className }: { card: CalendarConflictCard; compact?: boolean; onAsk?: (text: string) => void; className?: string }) {
  const t = useTranslations();
  const rows = compact ? card.conflicts.slice(0, COMPACT_ROWS) : card.conflicts;
  const clear = card.conflicts.length === 0;
  return (
    <CardFrame
      icon={clear ? CheckCircle2 : CalendarX2}
      tone={clear ? 'success' : 'warning'}
      title={card.title}
      subtitle={card.subtitle ?? (clear ? 'No overlaps found' : `${card.conflicts.length} ${card.conflicts.length === 1 ? 'overlap' : 'overlaps'}`)}
      href={card.href}
      hrefLabel="Calendar"
      compact={compact}
      className={className}
    >
      {clear ? (
        <p className="text-sm text-muted">{t('calendarConflict.nobodyIsDoubleBooked')}</p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((c, i) => (
            <li key={`${c.when}-${i}`} className="rounded-xl bg-warning/5 px-3 py-2">
              <p className="text-sm">
                <span className="font-medium">{c.titles.join(' and ')}</span>
                <span className="text-muted"> overlap {c.when}</span>
                {c.member && <span className="text-muted"> · {c.member}</span>}
              </p>
              {onAsk && !compact && c.titles[0] && (
                <button
                  type="button"
                  onClick={() => onAsk(`Move ${c.titles[0]} so it doesn't overlap ${c.when}`)}
                  className="focus-ring coarse:min-h-11 mt-1 rounded-lg px-2 py-1 text-xs font-medium text-brand-text hover:bg-elevated"
                >
                  Move {c.titles[0]}
                </button>
              )}
            </li>
          ))}
          <MoreRow count={card.conflicts.length - rows.length} />
        </ul>
      )}
    </CardFrame>
  );
}
