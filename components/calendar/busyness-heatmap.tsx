'use client';

import { useEffect, useMemo, useState } from 'react';
import { Flame, ChevronDown } from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import { cn } from '@/lib/utils/cn';
import { buildHeatmap, type HeatEvent } from '@/lib/calendar/heatmap';
import { expandEvents } from '@/lib/calendar/recurrence';
import type { Tables } from '@/lib/database.types';

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
 * Busy-week heat strip (TimeTree-style heat map, gap #16): the last 8 weeks of
 * family load at a glance, with the chronically-heaviest weekday named and a
 * concrete rebalancing tip. Self-contained fetch (the calendar grid's window
 * is forward-looking; this needs history).
 */
export function BusynessHeatmap({ familyId }: { familyId: string }) {
  const [rows, setRows] = useState<Tables<'calendar_events'>[]>([]);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    let alive = true;
    const start = new Date(Date.now() - WEEKS * 7 * 86400_000);
    createClient().from('calendar_events').select('*')
      .eq('family_id', familyId)
      .lt('starts_at', new Date().toISOString())
      .or(`starts_at.gte.${start.toISOString()},recurrence.neq.none`)
      .order('starts_at')
      .limit(2000)
      .then(({ data }) => { if (alive && data) setRows(data as Tables<'calendar_events'>[]); });
    return () => { alive = false; };
  }, [familyId]);

  const report = useMemo(() => {
    const start = new Date(Date.now() - WEEKS * 7 * 86400_000);
    const occurrences = expandEvents(rows, start, new Date());
    const events: HeatEvent[] = occurrences.map(e => ({
      startsAt: e.starts_at, endsAt: e.ends_at, allDay: e.all_day,
    }));
    return buildHeatmap(events, new Date(), WEEKS);
  }, [rows]);

  // Column-per-week grid: pad so the strip starts on a Monday row.
  const firstDow = (new Date(report.days[0]?.date ?? Date.now()).getUTCDay() + 6) % 7;

  return (
    <div className="rounded-2xl border border-border bg-surface/40 p-4">
      <button onClick={() => setOpen(v => !v)} className="flex w-full items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-sm font-bold">
          <Flame className="h-4 w-4 text-brand-text" /> Busyness — last {WEEKS} weeks
        </span>
        <ChevronDown className={cn('h-4 w-4 text-muted transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
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
                  title={`${d.date}: ${d.count} event${d.count === 1 ? '' : 's'}${d.minutes ? ` · ${Math.round(d.minutes / 60 * 10) / 10}h` : ''}`}
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
