'use client';

import { useEffect, useMemo, useState } from 'react';
import { Flame, ChevronDown } from 'lucide-react';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { readDisplayCalendarOccurrences, CALENDAR_DISPLAY_CONTRACT, CALENDAR_SOURCE_ARCHIVE_ENABLED, type CalendarDisplayOccurrence } from '@/lib/calendar/display-occurrences';
import { ErrorState, SkeletonList } from '@/components/ui/states';
import { cn } from '@/lib/utils/cn';
import { buildHeatmap, type HeatEvent } from '@/lib/calendar/heatmap';
import { addDays, familyFetchRange } from '@/lib/calendar/day';
import { useFamilyClock } from '@/components/i18n/use-format';
import { useTranslations } from '@/components/i18n/locale-provider';

const WEEKS = 8;
const LEVEL_CLS = [
  'bg-elevated',
  'bg-brand/25',
  'bg-brand/45',
  'bg-brand/70',
  'bg-brand',
];
const DOW = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

/**
 * The family dates the strip covers — the `WEEKS * 7` ending today — and the
 * instants a read of them must span. All-day rows are on their own date (the
 * UTC date they are stored on, lib/calendar/day.ts), timed rows on the family's
 * day, so the window is the union of the two (familyFetchRange): a read from
 * the family's midnight missed the first date's all-day rows west of Greenwich.
 */
function heatWindow(todayKey: string, timeZone: string) {
  const fromDay = addDays(todayKey, -(WEEKS * 7 - 1));
  const toDay = addDays(todayKey, 1);
  return { fromDay, toDay, range: familyFetchRange(fromDay, toDay, timeZone) };
}

/**
 * Busy-week heat strip (TimeTree-style heat map, gap #16): the last 8 weeks of
 * family load at a glance, with the chronically-heaviest weekday named and a
 * concrete rebalancing tip. Self-contained fetch (the calendar grid's window
 * is forward-looking; this needs history).
 */
export function BusynessHeatmap({ familyId }: { familyId: string }) {
  const clock = useFamilyClock();
  const t = useTranslations();
  const [open, setOpen] = useState(true);

  // `.limit(2000)` here was not a bound: PostgREST caps a response at
  // `db-max-rows` (1,000) whatever the client asks for, and this read is
  // ordered by `starts_at` ASCENDING — so a family with more than 1,000 events
  // in the window lost the MOST RECENT weeks, which is the half the strip is
  // about. `readAllAsQuery` pages to a real ceiling and reports reaching it.
  //
  // The previous fetch also destructured `{ data }` and dropped `error`, so a
  // failed read set no rows and the strip rendered a calm, empty eight weeks
  // with advice underneath it — telling a family they are not busy because the
  // query broke. `useRealtimeQuery` is the house pattern and carries the error,
  // the offline fallback and the missing-table degrade that this bypassed.
  const todayKey = clock.todayKey();
  const { data: rows, error, loading, stale, refresh } = useRealtimeQuery<CalendarDisplayOccurrence>({
    table: 'calendar_events', familyId, deps: [familyId, todayKey, clock.timeZone, CALENDAR_DISPLAY_CONTRACT, CALENDAR_SOURCE_ARCHIVE_ENABLED],
    fetcher: (s) => {
      const { range, fromDay, toDay } = heatWindow(todayKey, clock.timeZone);
      return readDisplayCalendarOccurrences(s, familyId, {
        timedFrom: range.timedFrom.toISOString(), timedTo: range.timedTo.toISOString(),
        allDayFromDay: fromDay, allDayToDay: toDay,
      }, clock.timeZone, {overlap:true});
    },
  });
  useEffect(() => {
    if (!CALENDAR_SOURCE_ARCHIVE_ENABLED) return;
    const onFocus = () => { void refresh(); };
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 60_000);
    window.addEventListener('focus', onFocus);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', onFocus); };
  }, [refresh]);

  const projection = useMemo(() => {
    // A pending read is unknown. Persisted cache is a bounded stale prefix;
    // neither can establish a complete current workload or a quiet stretch.
    if (loading || stale || error) return {report:null,error:false};
    // Recurrence stepped, and days bucketed, in the FAMILY's zone (TIME-003);
    // all-day rows by their own date.
    const events: HeatEvent[] = rows.map(e => ({
      occurrenceKey:e.occurrenceKey, startsAt: e.starts_at, endsAt: e.ends_at, allDay: e.all_day,
    }));
    try {
      return {report:buildHeatmap(events, new Date(), WEEKS, clock.timeZone),error:false};
    } catch {
      return {report:null,error:true};
    }
  }, [rows, clock, loading, stale, error]);
  const report = projection.report;
  const displayError = error || (projection.error || stale && !loading ? t('actions.couldNotLoadThatReport') : null);

  // Column-per-week grid: pad so the strip starts on a Monday row.
  const firstDow = (new Date(report?.days[0]?.date ?? Date.now()).getUTCDay() + 6) % 7;

  return (
    <div className="rounded-2xl border border-border bg-surface/40 p-4">
      <button onClick={() => setOpen(v => !v)} className="flex w-full items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-bold">
          <Flame className="h-4 w-4 text-brand-text" /> {t('busynessHeatmap.busynessLast')} {WEEKS} weeks
        </span>
        <ChevronDown className={cn('h-4 w-4 text-muted transition-transform', open && 'rotate-180')} />
      </button>
      {open && displayError && (
        // A broken read must not render as eight calm weeks with advice under it.
        <div className="mt-3"><ErrorState message={displayError} onRetry={refresh} /></div>
      )}
      {open && !displayError && loading && <div className="mt-3"><SkeletonList /></div>}
      {open && !displayError && !loading && report && (
        <>
          <div className="mt-3 flex gap-2 overflow-x-auto no-scrollbar">
            <div className="flex flex-col gap-1 pr-1">
              {DOW.map((d, i) => (
                <span key={i} className="flex h-4 w-3 items-center text-[9px] font-semibold text-muted">{d}</span>
              ))}
            </div>
            <div className="grid flex-1" style={{ gridTemplateRows: 'repeat(7, 1rem)', gridAutoFlow: 'column', gap: '4px', gridAutoColumns: '1fr' }}>
              {Array.from({ length: firstDow }).map((_, i) => <span key={'pad' + i} />)}
              {report.days.map(d => (
                <span
                  key={d.date}
                  title={`${d.date}: ${d.count} event${d.count === 1 ? '' : 's'}${d.minutes ? d.estimated ? ` · ${t('missionsNew.estimatedMinutes')}: ${Math.round(d.minutes)}` : ` · ${Math.round(d.minutes / 60 * 10) / 10}h` : ''}`}
                  className={cn('h-4 min-w-3 rounded-[4px]', LEVEL_CLS[d.level],
                    d.level === 4 && 'ring-1 ring-rose-400/60')}
                />
              ))}
            </div>
          </div>
          <div className="mt-2 flex items-center justify-end gap-1 text-[10px] text-muted">
            calm {LEVEL_CLS.map((c, i) => <span key={i} className={cn('h-2.5 w-2.5 rounded-[3px]', c)} />)} packed
          </div>
          <p className="mt-2 text-xs text-muted">{report.advice}</p>
        </>
      )}
    </div>
  );
}
