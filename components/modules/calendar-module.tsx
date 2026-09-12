'use client';

import Link from 'next/link';

import { useMemo, useState, useEffect, useRef } from 'react';
import { ChevronLeft, ChevronRight, Plus, MapPin, RefreshCw, Filter, Check, Sparkles, Eye, EyeOff, Users, Columns } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { expandEvents } from '@/lib/calendar/recurrence';
import { BusynessHeatmap } from '@/components/calendar/busyness-heatmap';
import { describeDbError } from '@/lib/supabase/errors';
import { createCalendarEventAction, updateCalendarEventAction } from '@/app/(app)/dashboard/calendar/actions';
import { newSubmissionId } from '@/lib/utils/submission-id';
import { useToast } from '@/components/ui/toast';
import { Avatar } from '@/components/ui/avatar';
import { Modal } from '@/components/ui/modal';
import { Input, Textarea, Field, Select } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/app/page-header';
import { AiInsight } from '@/components/ai/ai-insight';
import { SkeletonList, ErrorState } from '@/components/ui/states';
import { eventSchema, fieldErrors } from '@/lib/validation';
import { EventDetailModal } from './event-detail-modal';
import { FindTimeModal } from './find-time-modal';
import { RoutinesPanel } from './routines-panel';
import { cn } from '@/lib/utils/cn';
import type { Tables } from '@/lib/database.types';
import { useTranslations } from '@/components/i18n/locale-provider';

type Event = Tables<'calendar_events'>;

const CATEGORY_COLORS: Record<string, string> = {
  general: 'bg-brand/20 border-brand/40 text-brand-text',
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

// "Show" toggles mirror the image's birthday / school / holiday switches.
const SHOW_TOGGLES = [
  { key: 'birthday', label: 'Birthdays', emoji: '🎁' },
  { key: 'school', label: 'School Events', emoji: '🏫' },
  { key: 'holiday', label: 'Holidays', emoji: '🎉' },
] as const;

// Sentinel "calendar" for events with no assignee (shared / whole-family).
const FAMILY_KEY = '__family__';

const HOURS = Array.from({ length: 16 }, (_, i) => i + 6); // 6am-9pm
const HOUR_HEIGHT = 64; // px per hour

function GoogleGlyph({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none"><path d="M17.64 9.205c0-.639-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615Z" fill="#4285F4"/><path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18Z" fill="#34A853"/><path d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332Z" fill="#FBBC05"/><path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 6.29C4.672 4.163 6.656 3.58 9 3.58Z" fill="#EA4335"/></svg>
  );
}

/** Outlook's four-square mark. Inline for the same reason GoogleGlyph is:
 *  no network fetch, and it renders identically in both themes. */
function OutlookGlyph({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="M8.5 1.5H1.5v7h7v-7Z" fill="#0364B8" />
      <path d="M16.5 1.5h-7v7h7v-7Z" fill="#0F78D4" />
      <path d="M8.5 9.5H1.5v7h7v-7Z" fill="#14A0E4" />
      <path d="M16.5 9.5h-7v7h7v-7Z" fill="#28C3F3" />
    </svg>
  );
}

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
                isToday && !isSelected && 'font-bold text-brand-text',
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

// Full-month grid view (image's "Month" tab).
function MonthGrid({ gridDays, monthAnchor, eventsByDay, todayStr, onSelect }: {
  gridDays: Date[]; monthAnchor: Date; eventsByDay: Map<string, Event[]>;
  todayStr: string; onSelect: (e: Event) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="grid grid-cols-7 border-b border-border">
        {['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map((d) => (
          <div key={d} className="border-l border-border py-2 text-center text-[10px] font-semibold uppercase tracking-wide text-muted first:border-l-0">{d}</div>
        ))}
      </div>
      <div className="grid flex-1 auto-rows-fr grid-cols-7">
        {gridDays.map((d, i) => {
          const dStr = d.toISOString().slice(0, 10);
          const inMonth = d.getMonth() === monthAnchor.getMonth();
          const isToday = dStr === todayStr;
          const evs = eventsByDay.get(dStr) ?? [];
          return (
            <div key={i} className={cn('min-h-[88px] overflow-hidden border-l border-t border-border p-1', !inMonth && 'bg-surface/30')}>
              <div className={cn('mb-1 flex h-6 w-6 items-center justify-center rounded-full text-xs', isToday ? 'bg-brand font-bold text-white' : inMonth ? 'text-fg' : 'text-muted')}>{d.getDate()}</div>
              <div className="space-y-0.5">
                {evs.slice(0, 3).map((e) => (
                  <button key={`${e.id}-${e.starts_at}`} onClick={() => onSelect(e)}
                    className={cn('flex w-full items-center gap-1 truncate rounded border px-1 py-0.5 text-left text-[10px]', CATEGORY_COLORS[e.category] ?? CATEGORY_COLORS.other)}>
                    <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', CATEGORY_DOT[e.category] ?? 'bg-muted')} />
                    <span className="truncate">{e.title}</span>
                  </button>
                ))}
                {evs.length > 3 && <div className="px-1 text-[9px] text-muted">+{evs.length - 3} more</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function CalendarModule() {
  const tr = useTranslations();
  const { familyId, userId, members, selfMember } = useApp();
  const [open, setOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [selected, setSelected] = useState<Event | null>(null);
  const [editing, setEditing] = useState<Event | null>(null);
  const [weekOffset, setWeekOffset] = useState(0);
  const [filterCategory, setFilterCategory] = useState<string>('all');
  const [catMenu, setCatMenu] = useState(false);
  const [memberMenu, setMemberMenu] = useState(false);
  const [view, setView] = useState<'day' | 'week' | 'month'>('week');
  // Per-member / per-category visibility (the image's Calendars + Show toggles).
  const [hiddenMembers, setHiddenMembers] = useState<Set<string>>(new Set());
  const [hiddenCategories, setHiddenCategories] = useState<Set<string>>(new Set());
  // Side-by-side per-member columns for the focused day (opt-in checkbox).
  const [splitByMember, setSplitByMember] = useState(false);
  const [gcalConnected, setGcalConnected] = useState<boolean | null>(null);
  // Outlook carries TWO flags where Google carries one. `connected` is the same
  // question; `configured` asks whether the server even holds Microsoft OAuth
  // credentials. They are independent — an unconfigured deployment is never
  // connected, but a configured one usually is not either — and conflating them
  // would either hide the button on every deployment that has not registered an
  // Entra app yet, or promise a connection the server cannot complete.
  const [outlookStatus, setOutlookStatus] = useState<{ configured: boolean; connected: boolean } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [mobileDayIndex, setMobileDayIndex] = useState(() => {
    const now = new Date();
    return (now.getDay() + 6) % 7; // 0=Mon
  });
  const { success, error: toastError } = useToast();
  const gridRef = useRef<HTMLDivElement>(null);

  const monday = useMemo(() => weekStart(weekOffset), [weekOffset]);
  const days = useMemo(() => daysOfWeek(monday), [monday]);

  // Month grid window — also the fetch window, so week / day / month all share
  // one query (it always covers the visible week too).
  const monthAnchor = useMemo(() => new Date(monday.getFullYear(), monday.getMonth(), 1), [monday]);
  const monthGridStart = useMemo(() => {
    const f = new Date(monthAnchor);
    f.setDate(1 - ((f.getDay() + 6) % 7));
    f.setHours(0, 0, 0, 0);
    return f;
  }, [monthAnchor]);
  const monthGridDays = useMemo(
    () => Array.from({ length: 42 }, (_, i) => { const d = new Date(monthGridStart); d.setDate(d.getDate() + i); return d; }),
    [monthGridStart],
  );
  const fetchEnd = useMemo(() => { const d = new Date(monthGridStart); d.setDate(d.getDate() + 42); return d; }, [monthGridStart]);

  useEffect(() => {
    fetch('/api/google/calendar/sync').then(r => r.json()).then((d: { connected: boolean }) => setGcalConnected(d.connected)).catch(() => setGcalConnected(false));
    // Independent of the Google probe on purpose: one provider being unreachable
    // must never decide what the other's control says. On any failure this
    // settles to "configured, not connected", which renders the Connect link —
    // and that link is safe even when the server holds no credentials, because
    // /api/sync/microsoft/auth redirects to the setup page rather than erroring.
    fetch('/api/sync/microsoft/status')
      .then(r => r.json())
      .then((d: { configured?: boolean; connected?: boolean }) =>
        setOutlookStatus({ configured: d.configured !== false, connected: d.connected === true }))
      .catch(() => setOutlookStatus({ configured: true, connected: false }));
    const params = new URLSearchParams(window.location.search);
    if (params.get('gcal') === 'connected') { success(tr('calendarModule.googleCalendarConnected')); window.history.replaceState({}, '', window.location.pathname); }
    else if (params.get('gcal') === 'error') { toastError(tr('calendarModule.googleCalendarConnectionFailed')); window.history.replaceState({}, '', window.location.pathname); }
  }, [success, toastError]); // eslint-disable-line react-hooks/exhaustive-deps

  // Scroll to 7am on mount
  useEffect(() => {
    if (gridRef.current) gridRef.current.scrollTop = HOUR_HEIGHT * 1;
  }, []);

  const { data: rawData, loading, error, refresh } = useRealtimeQuery<Event>({
    table: 'calendar_events', familyId, deps: [familyId, monthGridStart.toISOString()],
    // In-window events PLUS every recurring series that started before the
    // window's end — expandEvents below turns those into the occurrences that
    // actually fall inside the grid (a weekly event created in June must show
    // on every July Monday, not vanish after its first week).
    fetcher: (supabase) =>
      supabase.from('calendar_events').select('*').eq('family_id', familyId)
        .lt('starts_at', fetchEnd.toISOString())
        .or(`starts_at.gte.${monthGridStart.toISOString()},recurrence.neq.none`)
        .order('starts_at'),
  });

  // Recurring rules → concrete occurrences inside the visible window.
  const data = useMemo(
    () => expandEvents(rawData, monthGridStart, fetchEnd),
    [rawData, monthGridStart, fetchEnd],
  );

  const memberById = useMemo(() => new Map(members.map(m => [m.id, m])), [members]);

  const filtered = useMemo(() => {
    return data.filter((e) => {
      if (filterCategory !== 'all' && e.category !== filterCategory) return false;
      if (hiddenCategories.has(e.category)) return false;
      const mk = e.assignee_id ?? FAMILY_KEY;
      if (hiddenMembers.has(mk)) return false;
      return true;
    });
  }, [data, filterCategory, hiddenCategories, hiddenMembers]);

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

  // Combined per-day map (month chips + day list).
  const eventsByDay = useMemo(() => {
    const map = new Map<string, Event[]>();
    for (const e of filtered) {
      const key = new Date(e.starts_at).toISOString().slice(0, 10);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(e);
    }
    return map;
  }, [filtered]);

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
      const json = await res.json() as { synced?: number; error?: string; reconnect?: boolean };
      // A revoked or expired Google grant is not a failed sync — it is a
      // disconnected calendar. The server has already cleared the dead token,
      // so flipping this flag swaps the Sync button back to Connect Google, and
      // the toast names the one thing the user can actually do about it. Left
      // as a generic "Sync failed" this recurred weekly with no way forward.
      if (json.reconnect) {
        setGcalConnected(false);
        toastError(json.error ?? tr('sync.googleAccessExpiredReconnect'));
        return;
      }
      if (json.error) throw new Error(json.error);
      success(`Synced ${json.synced} events`); void refresh();
    } catch (err) { toastError(describeDbError(err, tr('calendarModule.syncFailed'))); }
    finally { setSyncing(false); }
  }

  function toggleMember(key: string) {
    setHiddenMembers((prev) => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  }
  function toggleCategory(key: string) {
    setHiddenCategories((prev) => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  }

  // Navigation honours the active view (day → ±1 day, week → ±1 week, month → ±1 month).
  function navStep(dir: -1 | 1) {
    if (view === 'month') { setWeekOffset((w) => w + dir * 4); return; }
    if (view === 'day') {
      setMobileDayIndex((i) => {
        const ni = i + dir;
        if (ni < 0) { setWeekOffset((w) => w - 1); return 6; }
        if (ni > 6) { setWeekOffset((w) => w + 1); return 0; }
        return ni;
      });
      return;
    }
    setWeekOffset((w) => w + dir);
  }
  function goToday() {
    setWeekOffset(0);
    setMobileDayIndex((new Date().getDay() + 6) % 7);
  }

  const todayStr = today.toISOString().slice(0, 10);
  const nowMins = new Date().getHours() * 60 + new Date().getMinutes();
  const nowTop = (nowMins - 6 * 60) * (HOUR_HEIGHT / 60);

  // Columns rendered by the time-grid: one day in day-view, the week otherwise.
  const gridColumns = view === 'day' ? [days[mobileDayIndex]] : days;

  // Mobile day data
  const mobileDay = days[mobileDayIndex];
  const mobileDayStr = mobileDay?.toISOString().slice(0, 10) ?? '';
  const mobileDayTimed = timedByDay.get(mobileDayStr) ?? [];
  const mobileDayAllDay = allDayByDay.get(mobileDayStr) ?? [];

  // Desktop time-grid columns: normally one per day (week / day view). When
  // "split by person" is on, the FOCUSED DAY is instead broken into one column
  // per visible member, so families can compare everyone's day side by side.
  // A member's column shows events assigned to them plus shared/family events.
  const visibleMembers = members.filter((m) => !hiddenMembers.has(m.id));
  const splitActive = splitByMember && visibleMembers.length > 0;
  const gridCols = splitActive
    ? visibleMembers.map((m) => {
        const own = (e: Event) => e.assignee_id === m.id || !e.assignee_id;
        return {
          key: m.id,
          date: mobileDay,
          isToday: mobileDayStr === todayStr,
          timed: (timedByDay.get(mobileDayStr) ?? []).filter(own),
          allDay: (allDayByDay.get(mobileDayStr) ?? []).filter(own),
          member: { name: m.display_name, color: m.color as string | null },
        };
      })
    : gridColumns.map((d) => {
        const dStr = d.toISOString().slice(0, 10);
        return {
          key: dStr,
          date: d,
          isToday: dStr === todayStr,
          timed: timedByDay.get(dStr) ?? [],
          allDay: allDayByDay.get(dStr) ?? [],
          member: undefined as { name: string; color: string | null } | undefined,
        };
      });

  if (loading) return <SkeletonList />;
  if (error) return <ErrorState message={error} onRetry={refresh} />;

  const dateLabel = view === 'month'
    ? monthAnchor.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
    : view === 'day' || splitActive
      // Split view compares members on one day, so label the focused day, not the week span.
      ? days[mobileDayIndex].toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' })
      : `${days[0].toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${days[6].toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;

  // "Calendars" list: every member + a synthetic whole-family entry.
  const calendarRows = [
    ...members.map((m) => ({ key: m.id, label: m.user_id === userId ? `${m.display_name} (Me)` : m.display_name, color: m.color })),
    { key: FAMILY_KEY, label: 'Family', color: null as string | null },
  ];

  return (
    <div className="module-with-sidebar">
      {/* Main calendar area */}
      <div className="module-main">
        {/* Top bar */}
        <div className="module-page flex-shrink-0 border-b border-border">
          <PageHeader
            title={tr('calendar.calendar')}
            description={tr('calendarModule.stayOnTopOfYour')}
            action={
              <div className="flex items-center gap-2">
                {/* Outlook sits to the LEFT of Google, and renders as soon as the
                    probe answers — including when it answers "not configured".
                    A plain <a>, like the Google control: no click handler, no
                    JS state machine to get stuck in, so it cannot land in a
                    half-pressed state and a middle-click still opens a tab.
                    /api/sync/microsoft/auth resolves every case itself —
                    signed out, unconfigured, or ready — which is why this needs
                    no branching beyond connected vs not. */}
                {outlookStatus?.connected === false && (
                  <a
                    href="/api/sync/microsoft/auth"
                    className="btn-inline"
                    title={outlookStatus.configured
                      ? tr('calendar.connectOutlookTitle')
                      : tr('calendar.connectOutlookSetupTitle')}
                  >
                    <OutlookGlyph /> {tr('calendar.connectOutlook')}
                  </a>
                )}
                {outlookStatus?.connected === true && (
                  <Link href="/dashboard/sync/accounts/microsoft" className="btn-inline">
                    <OutlookGlyph /> {tr('calendar.outlookConnected')}
                  </Link>
                )}
                {gcalConnected === false && (
                  <a href="/api/google/calendar/auth" className="btn-inline">
                    <GoogleGlyph /> {tr('calendar.connectGoogle')}
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
                  <Sparkles className="h-3.5 w-3.5" /> {tr('calendar.findATime')}
                </button>
                <Button size="sm" onClick={() => setOpen(true)}>
                  <Plus className="h-4 w-4" /> {tr('calendar.addEvent')}
                </Button>
              </div>
            }
          />

          {/* Nav + view switcher row */}
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            <div className="flex items-center gap-2">
              <button onClick={goToday} className="btn-inline">{tr('calendar.today')}</button>
              <div className="flex items-center gap-1">
                <button onClick={() => navStep(-1)} aria-label={tr('calendar.previous')} className="rounded-lg p-1.5 hover:bg-elevated transition"><ChevronLeft className="h-4 w-4" /></button>
                <button onClick={() => navStep(1)} aria-label={tr('calendar.next')} className="rounded-lg p-1.5 hover:bg-elevated transition"><ChevronRight className="h-4 w-4" /></button>
              </div>
              <span className="text-sm font-semibold">{dateLabel}</span>
            </div>

            <div className="ml-auto flex items-center gap-2">
              <div className="tab-bar">
                {(['day', 'week', 'month'] as const).map(v => (
                  <button key={v} onClick={() => setView(v)}
                    className={cn('tab-item capitalize', view === v ? 'tab-item-active' : 'tab-item-inactive')}>
                    {v}
                  </button>
                ))}
              </div>

              <div className="relative">
                <button onClick={() => setCatMenu(v => !v)}
                  className={cn('btn-inline', filterCategory !== 'all' && 'text-brand-text')}>
                  <Filter className="h-3.5 w-3.5" /> {filterCategory === 'all' ? 'Filters' : filterCategory[0].toUpperCase() + filterCategory.slice(1)}
                </button>
                {catMenu && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setCatMenu(false)} />
                    <div className="absolute right-0 z-20 mt-1 max-h-64 w-44 overflow-y-auto rounded-xl border border-border bg-elevated shadow-lg">
                      {(['all', 'general', 'school', 'sports', 'appointment', 'medication', 'maintenance', 'birthday', 'holiday', 'other'] as const).map(c => (
                        <button key={c} onClick={() => { setFilterCategory(c); setCatMenu(false); }}
                          className={cn('flex w-full items-center justify-between px-3 py-2 text-left text-xs hover:bg-surface transition capitalize',
                            filterCategory === c && 'text-brand-text font-semibold')}>
                          {c === 'all' ? 'All categories' : c}
                          {filterCategory === c && <Check className="h-3.5 w-3.5" />}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>

              {/* People / member-visibility popover (works on every screen size). */}
              <div className="relative">
                <button onClick={() => setMemberMenu(v => !v)} aria-label={tr('calendar.memberCalendars')}
                  className={cn('grid h-9 w-9 place-items-center rounded-full border border-border transition hover:bg-elevated', hiddenMembers.size > 0 && 'text-brand-text')}>
                  <Users className="h-4 w-4" />
                </button>
                {memberMenu && (
                  <>
                    <div className="fixed inset-0 z-10" onClick={() => setMemberMenu(false)} />
                    <div className="absolute right-0 z-20 mt-1 max-h-72 w-52 overflow-y-auto rounded-xl border border-border bg-elevated p-1.5 shadow-lg">
                      <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted">{tr('calendar.calendars')}</p>
                      {calendarRows.map((row) => {
                        const visible = !hiddenMembers.has(row.key);
                        return (
                          <button key={row.key} onClick={() => toggleMember(row.key)}
                            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-surface transition">
                            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: row.color ?? 'var(--brand, #7c5cff)' }} />
                            <span className={cn('flex-1 truncate', !visible && 'text-muted line-through')}>{row.label}</span>
                            {visible ? <Eye className="h-3.5 w-3.5 text-muted" /> : <EyeOff className="h-3.5 w-3.5 text-muted" />}
                          </button>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>

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
              <div className={cn('text-lg font-bold', mobileDayStr === todayStr ? 'text-brand-text' : 'text-fg')}>
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
              <div key={`${e.id}-${e.starts_at}`} onClick={() => setSelected(e)} className={cn('cursor-pointer rounded-lg border p-3 transition hover:brightness-110', CATEGORY_COLORS[e.category] ?? CATEGORY_COLORS.other)}>
                <div className="text-[10px] font-semibold uppercase tracking-wide opacity-70">{tr('calendar.allDay')}</div>
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
              <p className="py-8 text-center text-sm text-muted">{tr('calendar.noEventsThisDay')}</p>
            )}
            {mobileDayTimed.map(e => {
              const member = e.assignee_id ? memberById.get(e.assignee_id) : null;
              return (
                <div key={`${e.id}-${e.starts_at}`} onClick={() => setSelected(e)} className={cn('cursor-pointer rounded-lg border p-3 transition hover:brightness-110', CATEGORY_COLORS[e.category] ?? CATEGORY_COLORS.other)}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold">
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

        {/* ===== DESKTOP GRID (md+) ===== */}
        <div className="hidden min-h-0 flex-1 flex-col overflow-hidden md:flex">
          {view === 'month' ? (
            <MonthGrid gridDays={monthGridDays} monthAnchor={monthAnchor} eventsByDay={eventsByDay} todayStr={todayStr} onSelect={setSelected} />
          ) : (
            <>
              {/* Day headers */}
              <div className="flex flex-shrink-0 border-b border-border">
                <div className="w-14 flex-shrink-0" />
                {gridCols.map((col) => (
                  <div key={col.key} className="flex flex-1 flex-col items-center border-l border-border py-2">
                    {col.member ? (
                      <div className="flex flex-col items-center gap-0.5">
                        <Avatar name={col.member.name} color={col.member.color} size={22} />
                        <span className="max-w-[8rem] truncate text-[11px] font-semibold text-fg">{col.member.name}</span>
                      </div>
                    ) : (
                      <>
                        <span className={cn('text-[10px] font-semibold uppercase tracking-wide', col.isToday ? 'text-brand-text' : 'text-muted')}>
                          {col.date.toLocaleDateString('en-US', { weekday: 'short' })}
                        </span>
                        <span className={cn('flex h-7 w-7 items-center justify-center rounded-full text-sm font-bold', col.isToday ? 'bg-brand text-white' : 'text-fg')}>
                          {col.date.getDate()}
                        </span>
                      </>
                    )}
                    {/* All-day events */}
                    <div className="mt-1 w-full space-y-0.5 px-1">
                      {col.allDay.map(e => (
                        <div key={`${e.id}-${e.starts_at}`} onClick={() => setSelected(e)} className={cn('cursor-pointer truncate rounded px-1.5 py-0.5 text-[10px] font-medium border', CATEGORY_COLORS[e.category] ?? CATEGORY_COLORS.other)}>
                          {e.title}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
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
                {gridCols.map((col) => {
                  const dayEvents = col.timed;
                  return (
                    <div key={col.key} className="relative flex-1 border-l border-border" style={{ minHeight: HOURS.length * HOUR_HEIGHT }}>
                      {/* Hour lines */}
                      {HOURS.map(h => (
                        <div key={h} style={{ top: (h - 6) * HOUR_HEIGHT, height: HOUR_HEIGHT }} className="absolute left-0 right-0 border-t border-border/40" />
                      ))}

                      {/* Current time line */}
                      {col.isToday && nowTop >= 0 && nowTop <= HOURS.length * HOUR_HEIGHT && (
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
                          <div key={`${e.id}-${e.starts_at}`} style={{ top, height, left: 2, right: 2 }} onClick={() => setSelected(e)}
                            className={cn('absolute z-10 overflow-hidden rounded-md border p-1.5 text-[10px] cursor-pointer hover:brightness-110 transition', CATEGORY_COLORS[e.category] ?? CATEGORY_COLORS.other)}
                            title={e.title}>
                            <div className="flex items-start justify-between gap-1">
                              <span className="font-semibold leading-tight truncate">{new Date(e.starts_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })}</span>
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
            </>
          )}
        </div>

        {/* ===== Sync & Connect footer ===== */}
        <div className="flex-shrink-0 border-t border-border px-4 py-3 sm:px-6">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs">
            <div className="min-w-0">
              <div className="font-semibold">{tr('calendar.syncAmpConnect')}</div>
              <div className="text-muted">
                {gcalConnected ? 'Your calendar is connected and up to date.' : 'Connect a calendar to keep everything in sync.'}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <GoogleGlyph size={15} />
              <div className="leading-tight">
                <div className="font-medium">{tr('calendar.googleCalendar')}</div>
                <div className={cn('text-[11px]', gcalConnected ? 'text-green-400' : 'text-muted')}>{gcalConnected ? 'Connected' : 'Not connected'}</div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <RefreshCw className="h-4 w-4 text-brand-text" />
              <div className="leading-tight">
                <div className="font-medium">{tr('calendar.familySync')}</div>
                <div className="text-[11px] text-green-400">{tr('calendar.upToDate')}</div>
              </div>
            </div>
            <a href="/dashboard/sync" className="ml-auto font-medium text-brand-text hover:underline">{tr('calendar.manageConnections')}</a>
          </div>
        </div>

        {/* Busy-week heat map (last 8 weeks) */}
        <div className="mt-4">
          <BusynessHeatmap familyId={familyId} />
        </div>
      </div>

      {/* Right sidebar */}
      <div className="module-sidebar hidden lg:flex lg:flex-col gap-4">
        <div className="sidebar-card">
          <MiniCalendar current={days[mobileDayIndex]} onSelect={(d) => {
            const offset = Math.round((d.getTime() - weekStart(0).getTime()) / (7 * 86400000));
            setWeekOffset(offset);
            setMobileDayIndex((d.getDay() + 6) % 7);
          }} />
        </div>

        <div className="sidebar-card">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold text-muted uppercase tracking-wide">{tr('calendar.upcoming')}</span>
            <button onClick={() => setView('month')} className="text-[10px] font-medium text-brand-text hover:underline">{tr('calendar.viewAll')}</button>
          </div>
          {upcomingByDay.length === 0 ? (
            <p className="text-xs text-muted">{tr('calendar.nothingComingUp')}</p>
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
                  <div key={`${e.id}-${e.starts_at}`} onClick={() => setSelected(e)} className="mb-1 flex cursor-pointer items-start gap-2 rounded-lg p-1.5 hover:bg-elevated transition">
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
        </div>

        {/* Calendars — per-member visibility toggles */}
        <div className="sidebar-card">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold text-muted uppercase tracking-wide">{tr('calendar.calendars')}</span>
            <a href="/dashboard/settings#members" className="text-[10px] font-medium text-brand-text hover:underline">{tr('calendar.manage')}</a>
          </div>
          {/* Side-by-side per-member day view */}
          <label className="mb-1.5 flex cursor-pointer items-center gap-2 rounded-lg border border-border px-2 py-1.5 transition hover:bg-elevated">
            <input type="checkbox" checked={splitByMember} onChange={(e) => setSplitByMember(e.target.checked)}
              className="h-4 w-4 shrink-0 accent-brand" />
            <span className="flex-1 text-xs font-medium">{tr('calendar.sideBySideView')}</span>
            <Columns className="h-3.5 w-3.5 text-muted" />
          </label>
          {splitByMember && (
            <p className="mb-1.5 px-1 text-[10px] leading-4 text-muted">
              {tr('calendar.eachVisibleMemberGetsAColumn')} {mobileDay.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}{tr('calendar.toggleMembersBelowToShowOr')}
            </p>
          )}
          <div className="max-h-64 space-y-0.5 overflow-y-auto pr-1">
            {calendarRows.map((row) => {
              const visible = !hiddenMembers.has(row.key);
              return (
                <button key={row.key} onClick={() => toggleMember(row.key)}
                  className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1.5 text-left transition hover:bg-elevated">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: row.color ?? 'var(--brand, #7c5cff)' }} />
                  <span className={cn('flex-1 truncate text-xs', !visible && 'text-muted line-through')}>{row.label}</span>
                  {visible ? <Eye className="h-3.5 w-3.5 text-muted" /> : <EyeOff className="h-3.5 w-3.5 text-muted/60" />}
                </button>
              );
            })}
          </div>
        </div>

        {/* Show — category visibility toggles */}
        <div className="sidebar-card">
          <div className="mb-2 text-xs font-semibold text-muted uppercase tracking-wide">{tr('calendar.show')}</div>
          <div className="space-y-0.5">
            {SHOW_TOGGLES.map((t) => {
              const visible = !hiddenCategories.has(t.key);
              return (
                <label key={t.key} className="flex cursor-pointer items-center gap-2 rounded-lg px-1.5 py-1.5 transition hover:bg-elevated">
                  <input type="checkbox" checked={visible} onChange={() => toggleCategory(t.key)}
                    className="h-4 w-4 shrink-0 accent-brand" />
                  <span className="flex-1 text-xs">{t.label}</span>
                  <span aria-hidden>{t.emoji}</span>
                </label>
              );
            })}
          </div>
        </div>

        {/* Routines — detected + saved recurring-routine templates */}
        <RoutinesPanel events={data} weekStartMonday={monday} onApplied={refresh} />

        {/* Share Calendar */}
        <div className="sidebar-card">
          <div className="mb-1 text-xs font-semibold text-muted uppercase tracking-wide">{tr('calendar.shareCalendar')}</div>
          <p className="mb-2 text-xs text-muted">{tr('calendar.keepEveryoneInTheLoop')}</p>
          <a href="/dashboard/settings#members" className="flex items-center gap-2 text-xs font-medium text-brand-text hover:underline">
            <Users className="h-4 w-4" /> {tr('calendar.invitePeople')}
          </a>
        </div>
      </div>

      {open && <NewEventModal onClose={() => setOpen(false)} onSaved={() => { setOpen(false); void refresh(); }} />}
      {editing && <NewEventModal existing={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void refresh(); }} />}
      {findOpen && <FindTimeModal members={members} selfMemberId={selfMember?.id ?? null} onClose={() => setFindOpen(false)} onScheduled={() => { setFindOpen(false); void refresh(); }} />}
      {selected && (
        <EventDetailModal
          event={selected} members={members} selfMemberId={selfMember?.id ?? null} familyId={familyId}
          onClose={() => setSelected(null)}
          onEdit={(e) => { setSelected(null); setEditing(e); }}
          onDeleted={() => { setSelected(null); void refresh(); }}
        />
      )}
    </div>
  );
}

/** ISO → the local `datetime-local` input format (YYYY-MM-DDTHH:mm). */
function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function NewEventModal({ existing, onClose, onSaved }: {
  existing?: Event | null; onClose: () => void; onSaved: () => void;
}) {
  const tr = useTranslations();
  const { error: toastError } = useToast();
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  // One id for this composition, held across every retry of it. The modal
  // unmounts on save and on close, so the next Add Event mints a new one and two
  // deliberately identical events both get created; a Save pressed again after a
  // response that never arrived reuses this one and gets the first event back.
  //
  // Deliberately NOT reset when a save fails. The failure a parent retries is
  // usually a lost response, not a rejected write, and re-minting on failure is
  // exactly what turns that retry into the duplicate this is here to prevent.
  const submissionId = useRef('');
  if (!submissionId.current) submissionId.current = newSubmissionId();

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const input = {
      title: String(form.get('title') ?? ''),
      category: String(form.get('category') ?? 'general'),
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
      const recurrence = String(form.get('recurrence') ?? 'none');
      const fields = {
        title: parsed.data.title,
        startsAt: parsed.data.starts_at,
        endsAt: parsed.data.ends_at ?? null,
        category: parsed.data.category,
        location: parsed.data.location ?? null,
        description: parsed.data.description ?? null,
        recurrence,
      };
      // No family_id and no created_by: the action reads both from the session,
      // so this component can no longer name the household it writes into.
      const result = existing
        ? await updateCalendarEventAction(existing.id, fields)
        : await createCalendarEventAction({ ...fields, submissionId: submissionId.current });
      if (!result.ok) { toastError(result.error); return; }
      onSaved();
    } catch (err) {
      toastError(describeDbError(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal open title={existing ? 'Edit Event' : 'Add Event'} onClose={onClose}>
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label={tr('calendar.title')} error={errors.title} required>
          {(id) => <Input id={id} name="title" autoFocus placeholder={tr('calendar.teamDinner')} defaultValue={existing?.title ?? ''} />}
        </Field>
        <Field label={tr('calendar.category')}>
          {(id) => (
            <Select id={id} name="category" defaultValue={existing?.category ?? 'general'}>
              {['general','school','sports','appointment','birthday','holiday','other'].map(c => (
                <option key={c} value={c}>{c.charAt(0).toUpperCase() + c.slice(1)}</option>
              ))}
            </Select>
          )}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={tr('calendar.starts')} error={errors.starts_at} required>
            {(id) => <Input id={id} name="starts_at" type="datetime-local" defaultValue={toLocalInput(existing?.starts_at ?? null)} />}
          </Field>
          <Field label={tr('calendar.ends')} error={errors.ends_at}>
            {(id) => <Input id={id} name="ends_at" type="datetime-local" defaultValue={toLocalInput(existing?.ends_at ?? null)} />}
          </Field>
        </div>
        <Field label={tr('calendar.location')}>
          {(id) => <Input id={id} name="location" placeholder={tr('calendar.homeSchool')} defaultValue={existing?.location ?? ''} />}
        </Field>
        <Field label={tr('calendar.repeat')}>
          {(id) => (
            <Select id={id} name="recurrence" defaultValue={existing?.recurrence ?? 'none'}>
              <option value="none">{tr('calendar.noRepeat')}</option>
              <option value="daily">{tr('calendar.everyDay')}</option>
              <option value="weekly">{tr('calendar.everyWeek')}</option>
              <option value="monthly">{tr('calendar.everyMonth')}</option>
              <option value="yearly">{tr('calendar.everyYear')}</option>
            </Select>
          )}
        </Field>
        <Field label={tr('calendar.notes')}>
          {(id) => <Textarea id={id} name="description" placeholder={tr('calendar.optionalDetails')} defaultValue={existing?.description ?? ''} />}
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="outline" size="sm" onClick={onClose}>{tr('calendar.cancel')}</Button>
          <Button type="submit" size="sm" loading={loading}>
            {loading ? 'Saving...' : existing ? 'Save Changes' : 'Add Event'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
