'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { ChevronLeft, ChevronRight, CalendarDays, Download } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { Button } from '@/components/ui/button';
import { ErrorState } from '@/components/ui/states';
import { VACATION_KINDS, lookup } from '@/lib/vacations/meta';
import { buildICS, type IcsEvent } from '@/lib/vacations/ics';
import type { Tables } from '@/lib/database.types';
import { useTranslations } from '@/components/i18n/locale-provider';

type Trip = Tables<'vacations'>;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DOW = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

function inRange(day: string, start: string | null, end: string | null): boolean {
  if (!start) return false;
  return day >= start && day <= (end || start);
}

export function VacationsCalendar() {
  const tr = useTranslations();
  const { familyId } = useApp();
  const { data: trips, error, refresh } = useRealtimeQuery<Trip>({ table: 'vacations', familyId, deps: [familyId], fetcher: (sb) => sb.from('vacations').select('*').eq('family_id', familyId) });

  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth());

  const cells = useMemo(() => {
    const first = new Date(year, month, 1);
    const startPad = first.getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const out: (string | null)[] = [];
    for (let i = 0; i < startPad; i++) out.push(null);
    for (let d = 1; d <= daysInMonth; d++) out.push(`${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
    return out;
  }, [year, month]);

  const datedTrips = trips.filter((t) => t.start_date);

  function prev() { if (month === 0) { setMonth(11); setYear((y) => y - 1); } else setMonth((m) => m - 1); }
  function next() { if (month === 11) { setMonth(0); setYear((y) => y + 1); } else setMonth((m) => m + 1); }

  function exportICS() {
    const events: IcsEvent[] = datedTrips.map((t) => ({ uid: t.id, title: `${lookup(VACATION_KINDS, t.kind).emoji} ${t.title}`, start: t.start_date!, end: t.end_date, location: t.destination, description: t.description }));
    const blob = new Blob([buildICS(events)], { type: 'text/calendar' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'bubaly-vacations.ics'; a.click();
    URL.revokeObjectURL(url);
  }

  // A genuine vacations read failure must surface + be retryable, not render as
  // an empty calendar (and a silently-empty .ics export). Missing-table/offline
  // are still degraded to an empty list by the hook.
  if (error) {
    return (
      <div className="space-y-5">
        <h1 className="flex items-center gap-2 text-2xl font-bold"><CalendarDays className="h-6 w-6 text-brand-text" /> {tr('vacationsCalendar.vacationCalendar')}</h1>
        <ErrorState message="Could not load your trips. Refresh and try again." onRetry={refresh} />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="flex items-center gap-2 text-2xl font-bold"><CalendarDays className="h-6 w-6 text-brand-text" /> {tr('vacationsCalendar.vacationCalendar')}</h1>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" onClick={exportICS}><Download className="h-4 w-4" /> {tr('vacationsCalendar.exportIcs')}</Button>
          <Link href="/dashboard/vacations"><Button size="sm" variant="ghost">{tr('vacationsCalendar.allTrips')}</Button></Link>
        </div>
      </div>
      <p className="-mt-2 text-xs text-muted">{tr('vacationsCalendar.exportImportsStraightIntoGoogleCalendar')}</p>

      <div className="rounded-2xl border border-border bg-surface/40 p-4">
        <div className="mb-3 flex items-center justify-between">
          <button onClick={prev} aria-label={tr('vacationsCalendar.previousMonth')} className="rounded-lg p-1.5 hover:bg-elevated"><ChevronLeft className="h-5 w-5" /></button>
          <h2 className="font-semibold">{MONTHS[month]} {year}</h2>
          <button onClick={next} aria-label={tr('vacationsCalendar.nextMonth')} className="rounded-lg p-1.5 hover:bg-elevated"><ChevronRight className="h-5 w-5" /></button>
        </div>
        <div className="grid grid-cols-7 gap-1 text-center text-xs text-muted">{DOW.map((d) => <div key={d} className="py-1">{d}</div>)}</div>
        <div className="grid grid-cols-7 gap-1">
          {cells.map((day, i) => {
            if (!day) return <div key={i} className="aspect-square rounded-lg" />;
            const dayTrips = datedTrips.filter((t) => inRange(day, t.start_date, t.end_date));
            const isToday = day === now.toISOString().slice(0, 10);
            return (
              <div key={i} className={`aspect-square overflow-hidden rounded-lg border p-1 text-left ${isToday ? 'border-brand' : 'border-border/50'} ${dayTrips.length ? 'bg-brand/5' : ''}`}>
                <span className={`text-[11px] ${isToday ? 'font-bold text-brand-text' : 'text-muted'}`}>{Number(day.slice(-2))}</span>
                <div className="mt-0.5 space-y-0.5">
                  {dayTrips.slice(0, 2).map((t) => (
                    <Link key={t.id} href={`/dashboard/vacations/${t.id}/overview`} className="block truncate rounded bg-brand/20 px-1 text-[9px] leading-tight text-fg hover:bg-brand/30">{lookup(VACATION_KINDS, t.kind).emoji} {t.title}</Link>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div>
        <h2 className="mb-2 text-sm font-semibold text-muted">{tr('vacationsCalendar.trips')}</h2>
        <div className="space-y-2">
          {datedTrips.sort((a, b) => (a.start_date! < b.start_date! ? -1 : 1)).map((t) => (
            <Link key={t.id} href={`/dashboard/vacations/${t.id}/overview`} className="flex items-center justify-between rounded-xl border border-border bg-surface/40 p-3 hover:border-brand/40">
              <span className="font-medium">{lookup(VACATION_KINDS, t.kind).emoji} {t.title}</span>
              <span className="text-xs text-muted">{t.start_date}{t.end_date ? ` → ${t.end_date}` : ''}</span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
