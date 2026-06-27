'use client';

import { useMemo, useState, useEffect, useRef } from 'react';
import { ChevronLeft, ChevronRight, Plus, MapPin, RefreshCw, Filter, Sparkles } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { useAction } from '@/lib/hooks/use-action';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { Avatar } from '@/components/ui/avatar';
import { Modal } from '@/components/ui/modal';
import { Input, Textarea, Field, Select } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/app/page-header';
import { AiInsight } from '@/components/ai/ai-insight';
import { LoadingBlock, ErrorState } from '@/components/ui/states';
import { eventSchema, fieldErrors } from '@/lib/validation';
import { CONTEXTS, CONTEXT_LABELS, CONTEXT_META } from '@/lib/calendar/scheduling';
import { FindTimeModal } from './find-time-modal';
import { EventDetailModal } from './event-detail-modal';
import { cn } from '@/lib/utils/cn';
import type { Tables, CalendarContext } from '@/lib/database.types';

type Event = Tables<'calendar_events'>;

/** Resilient read of an event's context — '' / undefined pre-migration → 'family'. */
function eventContext(e: Event): CalendarContext {
  const c = (e as { context?: string | null }).context;
  return c === 'personal' || c === 'work' ? c : 'family';
}

const CATEGORY_COLORS: Record<string, string> = {
  general: 'bg-brand/20 border-brand/40 text-brand',
  school: 'bg-blue-500/20 border-blue-500/40 text-blue-400',
  sports: 'bg-green-500/20 border-green-500/40 text-green-400',
  appointment: 'bg-amber-500/20 border-amber-500/40 text-amber-400',
  medication: 'bg-red-500/20 border-red-500/40 text-red-400',
  maintenance: 'bg-orange-500/20 border-orange-500/40 text-orange-400',
  birthday: 'bg-pink-500/20 border-pink-500/40 text-pink-400',
  holiday: 'bg-teal-500/20 border-teal-500/40 text-teal-400',
  other: 'bg-surface border-border text-muted',
};
const CATEGORY_DOT: Record<string, string> = {
  general: 'bg-brand', school: 'bg-blue-400', sports: 'bg-green-400',
  appointment: 'bg-amber-400', medication: 'bg-red-400', maintenance: 'bg-orange-400',
  birthday: 'bg-pink-400', holiday: 'bg-teal-400', other: 'bg-muted',
};

const HOURS = Array.from({ length: 16 }, (_, i) => i + 6); // 6am-9pm
const HOUR_HEIGHT = 64; // px per hour

function weekStart(offset = 0): Date {
  const d = new Date();
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day + offset * 7);
  d.setHours(0, 0, 0, 0);
  return d;
}

function daysOfWeek(monday: Date) {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return d;
  });
}

function fmtHour(h: number) {
  return h === 12 ? '12 PM' : h < 12 ? `${h} AM` : `${h - 12} PM`;
}

// Group events by local ISO date (YYYY-MM-DD).
function byDay(events: Event[]): Map<string, Event[]> {
  const map = new Map<string, Event[]>();
  for (const e of events) {
    const d = new Date(e.starts_at);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(e);
  }
  return map;
}

// 42 days (6 weeks) covering the month that `anchor` falls in, Monday-first.
function monthGridDays(anchor: Date): Date[] {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const startOffset = (first.getDay() + 6) % 7;
  const gridStart = new Date(first);
  gridStart.setDate(1 - startOffset);
  gridStart.setHours(0, 0, 0, 0);
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    return d;
  });
}

function eventTop(e: Event): number {
  const d = new Date(e.starts_at);
  return ((d.getHours() - 6) * 60 + d.getMinutes()) * (HOUR_HEIGHT / 60);
}

function eventHeight(e: Event): number {
  if (!e.ends_at) return HOUR_HEIGHT;
  const mins = (new Date(e.ends_at).getTime() - new Date(e.starts_at).getTime()) / 60000;
  return Math.max(mins * (HOUR_HEIGHT / 60), 24);
}

// Mini calendar for the right sidebar
function MiniCalendar({ current, onSelect }: { current: Date; onSelect: (d: Date) => void }) {
  const [month, setMonth] = useState(() => new Date(current.getFullYear(), current.getMonth(), 1));
  const today = new Date(); today.setHours(0, 0, 0, 0);

  const days = useMemo(() => {
    const first = new Date(month); first.setDate(1);
    const startOffset = (first.getDay() + 6) % 7;
    const cells: (Date | null)[] = Array(startOffset).fill(null);
    const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    for (let i = 1; i <= daysInMonth; i++) cells.push(new Date(month.getFullYear(), month.getMonth(), i));
    return cells;
  }, [month]);

  return (
    <div className="w-full">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-sm font-semibold">{month.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</span>
        <div className="flex gap-1">
          <button onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} className="rounded p-1 hover:bg-elevated"><ChevronLeft className="h-3.5 w-3.5" /></button>
          <button onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} className="rounded p-1 hover:bg-elevated"><ChevronRight className="h-3.5 w-3.5" /></button>
        </div>
      </div>
      <div className="grid grid-cols-7 gap-0.5 text-center">
        {['S','M','T','W','T','F','S'].map((d, i) => (
          <div key={i} className="py-1 text-[10px] font-semibold text-muted">{d}</div>
        ))}
        {days.map((d, i) => {
          if (!d) return <div key={i} />;
          const isToday = d.getTime() === today.getTime();
          const isSelected = d.toDateString() === current.toDateString();
          return (
            <button key={i} onClick={() => onSelect(d)}
              className={cn('rounded py-1 text-xs transition hover:bg-elevated',
                isSelected && 'bg-brand text-white hover:bg-brand',
                isToday && !isSelected && 'font-bold text-brand',
                !isSelected && !isToday && 'text-fg',
              )}>
              {d.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function CalendarModule() {
  const { familyId, userId, members, selfMember } = useApp();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Event | null>(null);
  const [weekOffset, setWeekOffset] = useState(0);
  const [filterMember, setFilterMember] = useState<string>('all');
  const [filterContext, setFilterContext] = useState<'all' | CalendarContext>('all');
  const [findOpen, setFindOpen] = useState(false);
  const [prefillDate, setPrefillDate] = useState<Date | null>(null);
  const [view, setView] = useState<'week' | 'month' | 'agenda'>('week');
  const [monthAnchor, setMonthAnchor] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const [gcalConnected, setGcalConnected] = useState<boolean | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [mobileDayIndex, setMobileDayIndex] = useState(() => {
    const now = new Date();
    return (now.getDay() + 6) % 7; // 0=Mon
  });
  const { success, error: toastError } = useToast();
  const gridRef = useRef<HTMLDivElement>(null);

  const monday = useMemo(() => weekStart(weekOffset), [weekOffset]);
  const days = useMemo(() => daysOfWeek(monday), [monday]);

  // The 6-week (42-cell) grid covering the anchored month, Monday-first.
  const monthGrid = useMemo(() => monthGridDays(monthAnchor), [monthAnchor]);

  // Fetch bounds widen with the view so month/agenda see beyond the current week.
  const range = useMemo(() => {
    if (view === 'month') return { start: monthGrid[0], end: new Date(monthGrid[41].getTime() + 86400000) };
    if (view === 'agenda') { const s = new Date(); s.setHours(0, 0, 0, 0); return { start: s, end: new Date(s.getTime() + 45 * 86400000) }; }
    return { start: days[0], end: new Date(days[6].getTime() + 86400000) };
  }, [view, days, monthGrid]);

  useEffect(() => {
    fetch('/api/google/calendar/sync').then(r => r.json()).then((d: { connected: boolean }) => setGcalConnected(d.connected)).catch(() => setGcalConnected(false));
    const params = new URLSearchParams(window.location.search);
    if (params.get('gcal') === 'connected') { success('Google Calendar connected!'); window.history.replaceState({}, '', window.location.pathname); }
    else if (params.get('gcal') === 'error') { toastError('Google Calendar connection failed.'); window.history.replaceState({}, '', window.location.pathname); }
    // Deep-link from the Front Desk "AI Scheduling Agent" card → open Find a time.
    if (params.get('find') === '1') { setFindOpen(true); window.history.replaceState({}, '', window.location.pathname); }
  }, [success, toastError]); // eslint-disable-line react-hooks/exhaustive-deps

  // Scroll to 7am on mount
  useEffect(() => {
    if (gridRef.current) gridRef.current.scrollTop = HOUR_HEIGHT * 1;
  }, []);

  const { data, loading, error, refresh } = useRealtimeQuery<Event>({
    table: 'calendar_events', familyId, deps: [familyId, view, range.start.toISOString(), range.end.toISOString()],
    fetcher: (supabase) =>
      supabase.from('calendar_events').select('*').eq('family_id', familyId)
        .gte('starts_at', range.start.toISOString()).lte('starts_at', range.end.toISOString())
        .order('starts_at'),
  });

  const memberById = useMemo(() => new Map(members.map(m => [m.id, m])), [members]);

  const filtered = useMemo(() =>
    data.filter(e =>
      (filterMember === 'all' || e.assignee_id === filterMember) &&
      (filterContext === 'all' || eventContext(e) === filterContext)),
    [data, filterMember, filterContext]);

  const allDay = filtered.filter(e => e.all_day);
  const timed = filtered.filter(e => !e.all_day);

  // Group timed events by day (ISO date string)
  const timedByDay = useMemo(() => {
    const map = new Map<string, Event[]>();
    for (const e of timed) {
      const key = new Date(e.starts_at).toISOString().slice(0, 10);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(e);
    }
    return map;
  }, [timed]);

  const allDayByDay = useMemo(() => {
    const map = new Map<string, Event[]>();
    for (const e of allDay) {
      const key = new Date(e.starts_at).toISOString().slice(0, 10);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(e);
    }
    return map;
  }, [allDay]);

  // Upcoming events for sidebar (next 7 days)
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const upcoming = useMemo(() => {
    const now = new Date(); now.setHours(0, 0, 0, 0);
    const weekEnd = new Date(now.getTime() + 7 * 86400000);
    return [...data].filter(e => {
      const d = new Date(e.starts_at);
      return d >= now && d <= weekEnd;
    }).sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime()).slice(0, 8);
  }, [data]);

  const upcomingByDay = useMemo(() => {
    const map = new Map<string, Event[]>();
    for (const e of upcoming) {
      const key = new Date(e.starts_at).toISOString().slice(0, 10);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(e);
    }
    return [...map.entries()];
  }, [upcoming]);

  async function syncGoogle() {
    setSyncing(true);
    try {
      const res = await fetch('/api/google/calendar/sync', { method: 'POST' });
      const json = await res.json() as { synced?: number; error?: string };
      if (json.error) throw new Error(json.error);
      success(`Synced ${json.synced} events`); void refresh();
    } catch (err) { toastError(err instanceof Error ? err.message : 'Sync failed'); }
    finally { setSyncing(false); }
  }

  const todayStr = today.toISOString().slice(0, 10);
  const nowMins = new Date().getHours() * 60 + new Date().getMinutes();
  const nowTop = (nowMins - 6 * 60) * (HOUR_HEIGHT / 60);

  // Mobile day data
  const mobileDay = days[mobileDayIndex];
  const mobileDayStr = mobileDay?.toISOString().slice(0, 10) ?? '';
  const mobileDayTimed = timedByDay.get(mobileDayStr) ?? [];
  const mobileDayAllDay = allDayByDay.get(mobileDayStr) ?? [];

  if (loading) return <LoadingBlock />;
  if (error) return <ErrorState message={error} onRetry={refresh} />;

  const dateLabel = view === 'month'
    ? monthAnchor.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
    : view === 'agenda'
      ? 'Next 45 days'
      : `${days[0].toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${days[6].toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;

  const goToday = () => { setWeekOffset(0); setMonthAnchor(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); }); };
  const goPrev = () => view === 'month' ? setMonthAnchor(m => new Date(m.getFullYear(), m.getMonth() - 1, 1)) : setWeekOffset(w => w - 1);
  const goNext = () => view === 'month' ? setMonthAnchor(m => new Date(m.getFullYear(), m.getMonth() + 1, 1)) : setWeekOffset(w => w + 1);

  return (
    <div className="module-with-sidebar">
      {/* Main calendar area */}
      <div className="module-main">
        {/* Top bar */}
        <div className="module-page flex-shrink-0 border-b border-border">
          <PageHeader
            title="Calendar"
            action={
              <div className="flex items-center gap-2">
                {gcalConnected === false && (
                  // OAuth start is a server route that 302-redirects to Google — needs a full
                  // navigation, not client-side <Link> routing.
                  // eslint-disable-next-line @next/next/no-html-link-for-pages
                  <a href="/api/google/calendar/auth" className="btn-inline">
                    <svg width="13" height="13" viewBox="0 0 18 18" fill="none"><path d="M17.64 9.205c0-.639-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615Z" fill="#4285F4"/><path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18Z" fill="#34A853"/><path d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332Z" fill="#FBBC05"/><path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 6.29C4.672 4.163 6.656 3.58 9 3.58Z" fill="#EA4335"/></svg>
                    Connect Google
                  </a>
                )}
                {gcalConnected && (
                  <button onClick={syncGoogle} disabled={syncing} className="btn-inline">
                    <RefreshCw className={cn('h-3 w-3', syncing && 'animate-spin')} />
                    {syncing ? 'Syncing...' : 'Sync'}
                  </button>
                )}
                <AiInsight kind="calendar" />
                <button onClick={() => setFindOpen(true)} className="btn-inline">
                  <Sparkles className="h-3.5 w-3.5" /> Find a time
                </button>
                <Button size="sm" onClick={() => setOpen(true)}>
                  <Plus className="h-4 w-4" /> Add Event
                </Button>
              </div>
            }
          />

          {/* Nav + view switcher row */}
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            <div className="flex items-center gap-2">
              <button onClick={goToday} className="btn-inline">Today</button>
              {view !== 'agenda' && (
                <div className="flex items-center gap-1">
                  <button onClick={goPrev} className="rounded-lg p-1.5 hover:bg-elevated transition"><ChevronLeft className="h-4 w-4" /></button>
                  <button onClick={goNext} className="rounded-lg p-1.5 hover:bg-elevated transition"><ChevronRight className="h-4 w-4" /></button>
                </div>
              )}
              <span className="text-sm font-semibold">{dateLabel}</span>
            </div>

            <div className="ml-auto flex items-center gap-2">
              <div className="tab-bar">
                {(['week', 'month', 'agenda'] as const).map(v => (
                  <button key={v} onClick={() => setView(v)}
                    className={cn('tab-item capitalize', view === v ? 'tab-item-active' : 'tab-item-inactive')}>
                    {v}
                  </button>
                ))}
              </div>

              <button className="btn-inline">
                <Filter className="h-3.5 w-3.5" /> Filters
              </button>
            </div>
          </div>

          {/* Member filter pills */}
          <div className="mt-3 flex items-center gap-2 overflow-x-auto scrollbar-none">
            <button onClick={() => setFilterMember('all')}
              className={cn('flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition',
                filterMember === 'all' ? 'border-brand/50 bg-brand/15 text-brand' : 'border-border bg-surface/40 text-muted hover:text-fg')}>
              <div className={cn('h-1.5 w-1.5 rounded-full', filterMember === 'all' ? 'bg-brand' : 'bg-muted')} /> All
            </button>
            {members.map(m => (
              <button key={m.id} onClick={() => setFilterMember(m.id === filterMember ? 'all' : m.id)}
                className={cn('flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition',
                  filterMember === m.id ? 'border-brand/50 bg-brand/15 text-brand' : 'border-border bg-surface/40 text-muted hover:text-fg')}>
                <Avatar name={m.display_name} color={m.color} size={18} />
                {m.display_name}
              </button>
            ))}
          </div>

          {/* Context lens — separate personal/work/family while seeing it all together */}
          <div className="mt-2 flex items-center gap-2 overflow-x-auto scrollbar-none">
            <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-muted">Lens</span>
            <button onClick={() => setFilterContext('all')}
              className={cn('flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition',
                filterContext === 'all' ? 'border-brand/50 bg-brand/15 text-brand' : 'border-border bg-surface/40 text-muted hover:text-fg')}>
              <div className={cn('h-1.5 w-1.5 rounded-full', filterContext === 'all' ? 'bg-brand' : 'bg-muted')} /> Everything
            </button>
            {CONTEXTS.map(c => (
              <button key={c} onClick={() => setFilterContext(c === filterContext ? 'all' : c)}
                className={cn('flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition',
                  filterContext === c ? cn('border-transparent', CONTEXT_META[c].chip) : 'border-border bg-surface/40 text-muted hover:text-fg')}>
                <div className={cn('h-1.5 w-1.5 rounded-full', CONTEXT_META[c].dot)} /> {CONTEXT_LABELS[c]}
              </button>
            ))}
          </div>
        </div>

        {view === 'week' && (<>
        {/* ===== MOBILE DAY VIEW (below md) ===== */}
        <div className="flex flex-1 flex-col overflow-y-auto md:hidden">
          {/* Mobile day selector */}
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <button onClick={() => setMobileDayIndex(i => (i - 1 + 7) % 7)} className="rounded-lg p-1.5 hover:bg-elevated transition">
              <ChevronLeft className="h-5 w-5" />
            </button>
            <div className="text-center">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted">
                {mobileDay.toLocaleDateString('en-US', { weekday: 'long' })}
              </div>
              <div className={cn('text-lg font-bold', mobileDayStr === todayStr ? 'text-brand' : 'text-fg')}>
                {mobileDay.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              </div>
            </div>
            <button onClick={() => setMobileDayIndex(i => (i + 1) % 7)} className="rounded-lg p-1.5 hover:bg-elevated transition">
              <ChevronRight className="h-5 w-5" />
            </button>
          </div>

          {/* Mobile day events */}
          <div className="flex-1 space-y-1 p-4">
            {/* All-day events */}
            {mobileDayAllDay.map(e => (
              <div key={e.id} onClick={() => setSelected(e)} className={cn('cursor-pointer rounded-lg border p-3 transition hover:brightness-110', CATEGORY_COLORS[e.category] ?? CATEGORY_COLORS.other)}>
                <div className="text-[10px] font-semibold uppercase tracking-wide opacity-70">All Day</div>
                <div className="text-sm font-semibold">{e.title}</div>
                {e.assignee_id && memberById.get(e.assignee_id) && (
                  <div className="mt-1 flex items-center gap-1.5 text-xs opacity-70">
                    <Avatar name={memberById.get(e.assignee_id)!.display_name} color={memberById.get(e.assignee_id)!.color} size={14} />
                    {memberById.get(e.assignee_id)!.display_name}
                  </div>
                )}
              </div>
            ))}

            {/* Timed events */}
            {mobileDayTimed.length === 0 && mobileDayAllDay.length === 0 && (
              <p className="py-8 text-center text-sm text-muted">No events this day</p>
            )}
            {mobileDayTimed.map(e => {
              const member = e.assignee_id ? memberById.get(e.assignee_id) : null;
              return (
                <div key={e.id} onClick={() => setSelected(e)} className={cn('cursor-pointer rounded-lg border p-3 transition hover:brightness-110', CATEGORY_COLORS[e.category] ?? CATEGORY_COLORS.other)}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 text-xs font-semibold">
                      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', CONTEXT_META[eventContext(e)].dot)} />
                      {new Date(e.starts_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}
                      {e.ends_at && ` – ${new Date(e.ends_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}`}
                    </span>
                    {member && <Avatar name={member.display_name} color={member.color} size={18} />}
                  </div>
                  <div className="mt-1 text-sm font-semibold">{e.title}</div>
                  {member && <div className="mt-0.5 text-xs opacity-70">{member.display_name}</div>}
                  {e.location && (
                    <div className="mt-1 flex items-center gap-1 text-xs opacity-70"><MapPin className="h-3 w-3" />{e.location}</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* ===== DESKTOP WEEK GRID (md+) ===== */}
        <div className="hidden min-h-0 flex-1 flex-col overflow-hidden md:flex">
          {/* Day headers */}
          <div className="flex flex-shrink-0 border-b border-border">
            <div className="w-14 flex-shrink-0" />
            {days.map((d, i) => {
              const dStr = d.toISOString().slice(0, 10);
              const isToday = dStr === todayStr;
              return (
                <div key={i} className="flex flex-1 flex-col items-center border-l border-border py-2">
                  <span className={cn('text-[10px] font-semibold uppercase tracking-wide', isToday ? 'text-brand' : 'text-muted')}>
                    {d.toLocaleDateString('en-US', { weekday: 'short' })}
                  </span>
                  <span className={cn('flex h-7 w-7 items-center justify-center rounded-full text-sm font-bold', isToday ? 'bg-brand text-white' : 'text-fg')}>
                    {d.getDate()}
                  </span>
                  {/* All-day events */}
                  <div className="mt-1 w-full space-y-0.5 px-1">
                    {(allDayByDay.get(dStr) ?? []).map(e => (
                      <div key={e.id} className={cn('truncate rounded px-1.5 py-0.5 text-[10px] font-medium border', CATEGORY_COLORS[e.category] ?? CATEGORY_COLORS.other)}>
                        {e.title}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Scrollable time grid */}
          <div ref={gridRef} className="flex min-h-0 flex-1 overflow-y-auto">
            {/* Time labels */}
            <div className="w-14 flex-shrink-0">
              {HOURS.map(h => (
                <div key={h} style={{ height: HOUR_HEIGHT }} className="relative flex items-start justify-end pr-2 pt-0">
                  <span className="relative -top-2 text-[10px] text-muted">{fmtHour(h)}</span>
                </div>
              ))}
            </div>

            {/* Day columns */}
            {days.map((d, i) => {
              const dStr = d.toISOString().slice(0, 10);
              const isToday = dStr === todayStr;
              const dayEvents = timedByDay.get(dStr) ?? [];
              return (
                <div key={i} className="relative flex-1 border-l border-border" style={{ minHeight: HOURS.length * HOUR_HEIGHT }}>
                  {/* Hour lines */}
                  {HOURS.map(h => (
                    <div key={h} style={{ top: (h - 6) * HOUR_HEIGHT, height: HOUR_HEIGHT }} className="absolute left-0 right-0 border-t border-border/40" />
                  ))}

                  {/* Current time line */}
                  {isToday && nowTop >= 0 && nowTop <= HOURS.length * HOUR_HEIGHT && (
                    <div style={{ top: nowTop }} className="absolute left-0 right-0 z-20 flex items-center">
                      <div className="h-2 w-2 rounded-full bg-brand" />
                      <div className="h-px flex-1 bg-brand" />
                    </div>
                  )}

                  {/* Events */}
                  {dayEvents.map(e => {
                    const top = eventTop(e);
                    const height = eventHeight(e);
                    const member = e.assignee_id ? memberById.get(e.assignee_id) : null;
                    if (top < 0 || top > HOURS.length * HOUR_HEIGHT) return null;
                    return (
                      <div key={e.id} style={{ top, height, left: 2, right: 2 }} onClick={() => setSelected(e)}
                        className={cn('absolute z-10 overflow-hidden rounded-md border p-1.5 text-[10px] cursor-pointer hover:brightness-110 transition', CATEGORY_COLORS[e.category] ?? CATEGORY_COLORS.other)}
                        title={e.title}>
                        <div className="flex items-start justify-between gap-1">
                          <span className="flex items-center gap-1 font-semibold leading-tight truncate">
                            <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', CONTEXT_META[eventContext(e)].dot)} />
                            {new Date(e.starts_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}
                          </span>
                          {height > 30 && member && <Avatar name={member.display_name} color={member.color} size={14} />}
                        </div>
                        {height > 24 && <div className="mt-0.5 truncate font-medium leading-tight">{e.title}</div>}
                        {height > 42 && member && <div className="mt-0.5 truncate text-[9px] opacity-70">{member.display_name}</div>}
                        {height > 54 && e.location && (
                          <div className="mt-0.5 flex items-center gap-0.5 text-[9px] opacity-70"><MapPin className="h-2 w-2" />{e.location}</div>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
        </>)}

        {view === 'month' && (
          <MonthView grid={monthGrid} anchorMonth={monthAnchor.getMonth()}
            eventsByDay={byDay(filtered)} memberById={memberById} onSelect={setSelected}
            onDayAdd={(d) => { setPrefillDate(d); setOpen(true); }} />
        )}

        {view === 'agenda' && (
          <AgendaView events={filtered} memberById={memberById} onSelect={setSelected} />
        )}
      </div>

      {/* Right sidebar */}
      <div className="module-sidebar hidden lg:flex lg:flex-col gap-4">
        <div className="sidebar-card">
          <MiniCalendar current={monday} onSelect={(d) => {
            const offset = Math.round((d.getTime() - weekStart(0).getTime()) / (7 * 86400000));
            setWeekOffset(offset);
          }} />
        </div>

        <div className="sidebar-card">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold text-muted uppercase tracking-wide">Upcoming</span>
            <span className="text-[10px] text-muted">Next 7 days</span>
          </div>
          {upcomingByDay.length === 0 ? (
            <p className="text-xs text-muted">Nothing coming up</p>
          ) : upcomingByDay.map(([day, events]) => {
            const d = new Date(day);
            const isToday2 = day === todayStr;
            const isTomorrow = day === new Date(today.getTime() + 86400000).toISOString().slice(0, 10);
            const label = isToday2 ? 'Today' : isTomorrow ? 'Tomorrow' : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
            return (
              <div key={day} className="mb-3">
                <div className="mb-1 text-[10px] font-semibold text-muted">
                  {label} &bull; {d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </div>
                {events.map(e => (
                  <div key={e.id} onClick={() => setSelected(e)} className="mb-1 flex cursor-pointer items-start gap-2 rounded-lg p-1.5 hover:bg-elevated transition">
                    <div className={cn('mt-1 h-1.5 w-1.5 flex-shrink-0 rounded-full', CATEGORY_DOT[e.category] ?? 'bg-muted')} />
                    <div className="min-w-0">
                      {!e.all_day && (
                        <div className="text-[10px] font-semibold text-muted">
                          {new Date(e.starts_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}
                        </div>
                      )}
                      <div className="truncate text-xs font-medium">{e.title}</div>
                      {e.assignee_id && memberById.get(e.assignee_id) && (
                        <div className="text-[10px] text-muted">{memberById.get(e.assignee_id)!.display_name}</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            );
          })}
          {upcoming.length > 0 && (
            <button className="mt-1 text-xs text-brand hover:underline">View full agenda →</button>
          )}
        </div>
      </div>

      {open && <NewEventModal familyId={familyId} userId={userId} members={members} selfMemberId={selfMember?.id ?? null} defaultDate={prefillDate} onClose={() => { setOpen(false); setPrefillDate(null); }} onSaved={() => { setOpen(false); setPrefillDate(null); void refresh(); }} />}
      {findOpen && <FindTimeModal members={members} selfMemberId={selfMember?.id ?? null} onClose={() => setFindOpen(false)} onScheduled={() => { setFindOpen(false); void refresh(); }} />}
      {selected && <EventDetailModal event={selected} members={members} selfMemberId={selfMember?.id ?? null} familyId={familyId} onClose={() => setSelected(null)} />}
    </div>
  );
}

function NewEventModal({ familyId, userId, members, selfMemberId, defaultDate, onClose, onSaved }: { familyId: string; userId: string; members: ReturnType<typeof useApp>['members']; selfMemberId: string | null; defaultDate?: Date | null; onClose: () => void; onSaved: () => void }) {
  const { error: toastError } = useToast();
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Prefill the start field with the tapped day at 9am (local), formatted for datetime-local.
  const defaultStart = useMemo(() => {
    if (!defaultDate) return '';
    const d = new Date(defaultDate); d.setHours(9, 0, 0, 0);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }, [defaultDate]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const input = {
      title: String(form.get('title') ?? ''),
      category: String(form.get('category') ?? 'general'),
      context: String(form.get('context') ?? 'family'),
      assignee_id: String(form.get('assignee_id') ?? '') || undefined,
      starts_at: String(form.get('starts_at') ?? ''),
      ends_at: String(form.get('ends_at') ?? '') || undefined,
      location: String(form.get('location') ?? '') || undefined,
      description: String(form.get('description') ?? '') || undefined,
    };
    const parsed = eventSchema.safeParse(input);
    if (!parsed.success) { setErrors(fieldErrors(parsed.error)); return; }
    // End must be after start when both are provided.
    if (parsed.data.ends_at && new Date(parsed.data.ends_at) <= new Date(parsed.data.starts_at)) {
      setErrors({ ends_at: 'End time must be after the start time.' });
      return;
    }
    setErrors({});
    setLoading(true);
    try {
      const supabase = createClient();
      const recurrence = String(form.get('recurrence') ?? 'none') as 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly';
      const { error } = await supabase.from('calendar_events').insert({ ...parsed.data, family_id: familyId, created_by: userId, all_day: false, recurrence });
      if (error) { toastError(describeDbError(error)); return; }
      onSaved();
    } catch (err) {
      toastError(describeDbError(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal open title="Add Event" onClose={onClose}>
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Title" error={errors.title} required>
          {(id) => <Input id={id} name="title" autoFocus placeholder="Team dinner" />}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Category">
            {(id) => (
              <Select id={id} name="category">
                {['general','school','sports','appointment','birthday','holiday','other'].map(c => (
                  <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Lens">
            {(id) => (
              <Select id={id} name="context" defaultValue="family">
                {CONTEXTS.map(c => <option key={c} value={c}>{CONTEXT_LABELS[c]}</option>)}
              </Select>
            )}
          </Field>
        </div>
        <Field label="Who's it for">
          {(id) => (
            <Select id={id} name="assignee_id" defaultValue={selfMemberId ?? ''}>
              <option value="">Whole family</option>
              {members.map(m => <option key={m.id} value={m.id}>{m.display_name}</option>)}
            </Select>
          )}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Starts" error={errors.starts_at} required>
            {(id) => <Input id={id} name="starts_at" type="datetime-local" defaultValue={defaultStart} />}
          </Field>
          <Field label="Ends" error={errors.ends_at}>
            {(id) => <Input id={id} name="ends_at" type="datetime-local" />}
          </Field>
        </div>
        <Field label="Location">
          {(id) => <Input id={id} name="location" placeholder="Home, School..." />}
        </Field>
        <Field label="Repeat">
          {(id) => (
            <Select id={id} name="recurrence">
              <option value="none">No repeat</option>
              <option value="daily">Every day</option>
              <option value="weekly">Every week</option>
              <option value="monthly">Every month</option>
              <option value="yearly">Every year</option>
            </Select>
          )}
        </Field>
        <Field label="Notes">
          {(id) => <Textarea id={id} name="description" placeholder="Optional details..." />}
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button type="submit" size="sm" loading={loading}>
            {loading ? 'Saving...' : 'Add Event'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function localKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Traditional month grid (6 weeks) with up to 3 event chips per day + an overflow
// count. Hovering a day reveals a quick "+" to add an event on that date.
function MonthView({ grid, anchorMonth, eventsByDay, memberById, onSelect, onDayAdd }: {
  grid: Date[];
  anchorMonth: number;
  eventsByDay: Map<string, Event[]>;
  memberById: Map<string, ReturnType<typeof useApp>['members'][number]>;
  onSelect: (e: Event) => void;
  onDayAdd: (d: Date) => void;
}) {
  const todayKey = localKey(new Date());
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="grid grid-cols-7 border-b border-border">
        {WEEKDAY_LABELS.map((d) => (
          <div key={d} className="py-2 text-center text-[10px] font-semibold uppercase tracking-wide text-muted">{d}</div>
        ))}
      </div>
      <div className="grid flex-1 grid-cols-7 grid-rows-6 overflow-y-auto">
        {grid.map((d, i) => {
          const key = localKey(d);
          const dayEvents = (eventsByDay.get(key) ?? []).slice().sort((a, b) => +new Date(a.starts_at) - +new Date(b.starts_at));
          const inMonth = d.getMonth() === anchorMonth;
          const isToday = key === todayKey;
          return (
            <div key={i} className={cn('group relative min-h-[84px] border-b border-l border-border p-1', !inMonth && 'bg-surface/30')}>
              <div className="mb-1 flex items-center justify-between">
                <span className={cn('flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold',
                  isToday ? 'bg-brand text-white' : inMonth ? 'text-fg' : 'text-muted')}>
                  {d.getDate()}
                </span>
                <button onClick={() => onDayAdd(d)} aria-label="Add event"
                  className="opacity-0 transition group-hover:opacity-100 rounded p-0.5 text-muted hover:bg-elevated hover:text-brand">
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="space-y-0.5">
                {dayEvents.slice(0, 3).map((e) => {
                  const member = e.assignee_id ? memberById.get(e.assignee_id) : null;
                  return (
                    <button key={e.id} onClick={() => onSelect(e)}
                      className={cn('flex w-full items-center gap-1 truncate rounded px-1 py-0.5 text-left text-[10px] font-medium transition hover:brightness-110', CATEGORY_COLORS[e.category] ?? CATEGORY_COLORS.other)}>
                      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', CONTEXT_META[eventContext(e)].dot)} />
                      {!e.all_day && <span className="shrink-0 opacity-70">{new Date(e.starts_at).toLocaleTimeString('en-US', { hour: 'numeric', hour12: true })}</span>}
                      <span className="truncate">{e.title}</span>
                      {member && <span className="ml-auto shrink-0"><Avatar name={member.display_name} color={member.color} size={12} /></span>}
                    </button>
                  );
                })}
                {dayEvents.length > 3 && (
                  <div className="px-1 text-[10px] font-medium text-muted">+{dayEvents.length - 3} more</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// A clean chronological list grouped by day — the fastest way to scan what's next.
function AgendaView({ events, memberById, onSelect }: {
  events: Event[];
  memberById: Map<string, ReturnType<typeof useApp>['members'][number]>;
  onSelect: (e: Event) => void;
}) {
  const todayKey = localKey(new Date());
  const tomorrowKey = localKey(new Date(Date.now() + 86400000));
  const groups = useMemo(() => {
    const map = byDay(events);
    return [...map.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([key, evs]) => [key, evs.slice().sort((a, b) => +new Date(a.starts_at) - +new Date(b.starts_at))] as const);
  }, [events]);

  if (groups.length === 0) {
    return <div className="flex flex-1 items-center justify-center p-10"><p className="text-sm text-muted">Nothing scheduled in this window.</p></div>;
  }

  return (
    <div className="flex-1 overflow-y-auto p-4 sm:p-6">
      <div className="mx-auto max-w-2xl space-y-5">
        {groups.map(([key, evs]) => {
          const d = new Date(key + 'T00:00:00');
          const label = key === todayKey ? 'Today' : key === tomorrowKey ? 'Tomorrow' : d.toLocaleDateString('en-US', { weekday: 'long' });
          return (
            <div key={key}>
              <div className="mb-2 flex items-baseline gap-2">
                <span className={cn('text-sm font-bold', key === todayKey ? 'text-brand' : 'text-fg')}>{label}</span>
                <span className="text-xs text-muted">{d.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}</span>
              </div>
              <div className="space-y-1.5">
                {evs.map((e) => {
                  const member = e.assignee_id ? memberById.get(e.assignee_id) : null;
                  return (
                    <button key={e.id} onClick={() => onSelect(e)}
                      className="flex w-full items-center gap-3 rounded-xl border border-border bg-surface/40 px-3 py-2.5 text-left transition hover:border-brand/40 hover:bg-elevated">
                      <div className="w-16 shrink-0 text-xs font-semibold text-muted">
                        {e.all_day ? 'All day' : new Date(e.starts_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}
                      </div>
                      <span className={cn('h-8 w-1 shrink-0 rounded-full', CONTEXT_META[eventContext(e)].dot)} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-semibold">{e.title}</div>
                        <div className="flex items-center gap-2 text-xs text-muted">
                          <span className={cn('rounded px-1 py-0.5 text-[10px] font-medium', CONTEXT_META[eventContext(e)].chip)}>{CONTEXT_LABELS[eventContext(e)]}</span>
                          {e.location && <span className="flex items-center gap-0.5 truncate"><MapPin className="h-3 w-3" />{e.location}</span>}
                        </div>
                      </div>
                      {member && <Avatar name={member.display_name} color={member.color} size={22} />}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
