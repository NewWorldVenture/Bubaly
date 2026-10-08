// Calendar conflict card: "soccer and the dentist overlap Saturday at 10:00"
// — one row per double-booking, who it affects, and a one-tap way to ask
// Bubaly to move one of them. No conflicts is good news and says so.
import { CalendarX2, CheckCircle2 } from 'lucide-react';
import { useTranslations } from '@/components/i18n/locale-provider';
import type { CalendarConflictCard, CalendarConflictSubject } from '@/lib/ai/result-cards';
import { CardFrame, MoreRow } from './index';

const COMPACT_ROWS = 3;

export function CalendarConflictCardView({ card, compact = false, onAsk, className }: { card: CalendarConflictCard; compact?: boolean; onAsk?: (text: string) => void; className?: string }) {
  const t = useTranslations();
  const advisories = card.advisories ?? [];
  const allRows = [
    ...card.conflicts.map(c => ({ when: c.when, titles: c.titles, member: c.member,
      family: false, subjects: 'subjects' in c ? c.subjects : [] })),
    ...advisories.map(c => ({ when: c.when, titles: c.subjects.map(subject => subject.title ?? t('calendarConflict.event')),
      member: null, family: true, subjects: c.subjects })),
  ];
  const rows = compact ? allRows.slice(0, COMPACT_ROWS) : allRows;
  const clear = allRows.length === 0;
  const counts = t('calendarConflict.counts', {
    personal: t(card.conflicts.length === 1 ? 'calendarConflict.personalOne' : 'calendarConflict.personalOther', { count: card.conflicts.length }),
    family: t(advisories.length === 1 ? 'calendarConflict.familyOne' : 'calendarConflict.familyOther', { count: advisories.length }),
  });
  const mutableTarget = (subjects: CalendarConflictSubject[]) => subjects.find(subject =>
    subject.kind === 'native' && subject.mutable === true && subject.readOnly === false
    && subject.eventId === subject.reference.eventId);
  return (
    <CardFrame
      icon={clear ? CheckCircle2 : CalendarX2}
      tone={clear ? 'success' : 'warning'}
      title={card.title}
      subtitle={card.subtitle ?? (clear ? t('calendarConflict.clearSubtitle') : counts)}
      href={card.href}
      hrefLabel={t('calendarConflict.calendar')}
      compact={compact}
      className={className}
    >
      {clear ? (
        <p className="text-sm text-muted">{card.advisories === undefined ? t('calendarConflict.nobodyIsDoubleBooked') : t('calendarConflict.clear')}</p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((c, i) => {
            const target = mutableTarget(c.subjects);
            return (
              <li key={`${c.when}-${i}`} className="rounded-xl bg-warning/5 px-3 py-2">
                <p className="text-sm">
                  {c.family && <span className="font-medium">{t('calendarConflict.familyLabel')} · </span>}
                  <span className="font-medium">{c.titles.join(t('calendarConflict.and'))}</span>
                  <span className="text-muted">{' '}{t('calendarConflict.overlapWhen', { when: c.when })}</span>
                  {c.member && <span className="text-muted"> · {c.member}</span>}
                </p>
                {c.family && <p className="text-xs text-muted">{t('calendarConflict.familyExplanation')}</p>}
                {onAsk && !compact && target?.kind === 'native' && (
                  <button
                    type="button"
                    onClick={() => onAsk(t('calendarConflict.moveNativeRequest', { eventId: target.eventId, title: target.title ?? t('calendarConflict.event'), occurrenceKey: target.occurrenceKey, when: c.when }))}
                    className="focus-ring coarse:min-h-11 mt-1 rounded-lg px-2 py-1 text-xs font-medium text-brand-text hover:bg-elevated"
                  >
                    {t('calendarConflict.move', { title: target.title ?? t('calendarConflict.event') })}
                  </button>
                )}
              </li>
            );
          })}
          <MoreRow count={allRows.length - rows.length} />
        </ul>
      )}
    </CardFrame>
  );
}
