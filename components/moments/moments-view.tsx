'use client';

// "Moments" — the anticipatory surface. Instead of asking the family to open
// Calendar → Weather → Grocery → Reminders before each upcoming event, this reads
// the next events and assembles a coordinated, one-tap prep bundle per moment
// (leave-by, packing, snacks, weather, budget, photos), remembering what's done.

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Sparkles, Clock, CloudSun, Backpack, ShoppingCart, PiggyBank, Stethoscope,
  Camera, Bell, ChevronRight, CalendarClock, Check, PartyPopper, Trophy, Plane,
  GraduationCap, Trees, CalendarDays,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/app/page-header';
import { SkeletonList, EmptyState } from '@/components/ui/states';
import { cn } from '@/lib/utils/cn';
import type { Tables } from '@/lib/database.types';
import {
  buildMomentPrep, momentWhen, type PrepDomain, type PrepItem, type MomentCategory,
} from '@/lib/moments/prep';
import {
  loadMomentPrep, setMomentPrepDoneAction, createMomentReminderAction,
} from '@/app/(app)/dashboard/moment-actions';

type Event = Tables<'calendar_events'>;

const DOMAIN_ICON: Record<PrepDomain, typeof Clock> = {
  time: Clock, weather: CloudSun, packing: Backpack, shopping: ShoppingCart,
  budget: PiggyBank, health: Stethoscope, photo: Camera, calendar: CalendarDays,
};
const CAT_ICON: Record<MomentCategory, typeof Clock> = {
  sports: Trophy, celebration: PartyPopper, trip: Plane, appointment: Stethoscope,
  school: GraduationCap, outdoors: Trees, general: CalendarClock,
};
const CAT_LABEL: Record<MomentCategory, string> = {
  sports: 'Game day', celebration: 'Celebration', trip: 'Trip', appointment: 'Appointment',
  school: 'School', outdoors: 'Outdoors', general: 'Coming up',
};

export function MomentsView() {
  const { familyId, userId } = useApp();
  const { success, error: toastError } = useToast();

  const nowISO = useMemo(() => new Date().toISOString(), []);
  const { data: rows, loading } = useRealtimeQuery<Event>({
    table: 'calendar_events', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('calendar_events').select('*')
      .eq('family_id', familyId).gte('starts_at', nowISO)
      .order('starts_at', { ascending: true }).limit(8),
  });

  const [done, setDone] = useState<Record<string, string[]>>({});
  const [pending, setPending] = useState<Set<string>>(new Set()); // `${eventId}:${itemId}` in flight

  useEffect(() => { loadMomentPrep().then(setDone).catch(() => { /* first-paint best effort */ }); }, []);

  const moments = useMemo(
    () => (rows ?? []).map((e) => ({ event: e, prep: buildMomentPrep(e) }))
      .filter((m) => m.prep.items.length > 0),
    [rows],
  );

  async function toggle(eventId: string, itemId: string) {
    const current = done[eventId] ?? [];
    const next = current.includes(itemId) ? current.filter((i) => i !== itemId) : [...current, itemId];
    const prev = done;
    setDone({ ...done, [eventId]: next });
    const res = await setMomentPrepDoneAction({ eventId, doneIds: next });
    if (!res.ok) { setDone(prev); toastError(res.error ?? 'Could not save'); }
  }

  async function remind(event: Event, item: PrepItem, leaveByISO: string | null) {
    const key = `${event.id}:${item.id}`;
    if (pending.has(key)) return;
    setPending((p) => new Set(p).add(key));
    // Leave-by fires at the leave time; other steps nudge the evening before (or 2h out).
    const start = new Date(event.starts_at).getTime();
    const remindAtISO = item.id === 'leave-by' && leaveByISO
      ? leaveByISO
      : new Date(Math.max(Date.now() + 60000, start - 20 * 3600000)).toISOString();
    const res = await createMomentReminderAction({
      familyId, title: item.reminderTitle ?? item.label, remindAtISO, eventId: event.id,
    });
    setPending((p) => { const n = new Set(p); n.delete(key); return n; });
    if (!res.ok) return toastError(res.error ?? 'Could not set reminder');
    success('Reminder set');
    if (!(done[event.id] ?? []).includes(item.id)) void toggle(event.id, item.id);
  }

  return (
    <div className="module-page">
      <PageHeader
        title="Moments"
        description="Your next events, already prepped. FamilyOS lines up everything each one needs — you just tap."
      />

      {loading ? <SkeletonList /> : moments.length === 0 ? (
        <EmptyState
          icon={Sparkles}
          title="Nothing on the horizon"
          description="When your family has upcoming events, FamilyOS will assemble the prep for each one here."
          action={<Link href="/dashboard/calendar" className="btn-cta">Open Calendar</Link>}
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {moments.map(({ event, prep }) => {
            const CatIcon = CAT_ICON[prep.category];
            const doneIds = done[event.id] ?? [];
            const total = prep.items.length;
            const complete = prep.items.filter((i) => doneIds.includes(i.id)).length;
            const allReady = complete === total;
            return (
              <section key={event.id} className="flex flex-col rounded-2xl border border-border bg-surface/40 p-4 sm:p-5">
                <div className="mb-3 flex items-start gap-3">
                  <span className={cn('grid h-11 w-11 shrink-0 place-items-center rounded-xl', allReady ? 'bg-emerald-500/15 text-emerald-400' : 'bg-brand/15 text-brand')}>
                    {allReady ? <Check className="h-5 w-5" /> : <CatIcon className="h-5 w-5" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="rounded-full bg-elevated px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted">{CAT_LABEL[prep.category]}</span>
                      <span className="text-xs font-medium text-brand">{momentWhen(event.starts_at, event.all_day)}</span>
                    </div>
                    <h2 className="mt-0.5 truncate text-base font-bold">{event.title}</h2>
                    {event.location && <p className="truncate text-xs text-muted">{event.location}</p>}
                  </div>
                  <span className={cn('shrink-0 text-xs font-semibold tabular-nums', allReady ? 'text-emerald-400' : 'text-muted')}>
                    {allReady ? 'Ready' : `${complete}/${total}`}
                  </span>
                </div>

                <ul className="space-y-1.5">
                  {prep.items.map((item) => {
                    const isDone = doneIds.includes(item.id);
                    const DIcon = DOMAIN_ICON[item.domain];
                    const key = `${event.id}:${item.id}`;
                    return (
                      <li key={item.id} className={cn('flex items-center gap-3 rounded-xl border px-3 py-2.5 transition', isDone ? 'border-border/50 bg-surface/20' : 'border-border bg-surface/40')}>
                        <button
                          type="button"
                          onClick={() => toggle(event.id, item.id)}
                          aria-pressed={isDone}
                          aria-label={isDone ? `Mark "${item.label}" not done` : `Mark "${item.label}" done`}
                          className={cn('grid h-6 w-6 shrink-0 place-items-center rounded-md border-2 transition',
                            isDone ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-border text-transparent hover:border-brand')}
                        >
                          <Check className="h-3.5 w-3.5" />
                        </button>
                        <span className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-elevated', isDone ? 'text-muted/50' : 'text-brand')}>
                          <DIcon className="h-4 w-4" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className={cn('truncate text-sm font-medium', isDone && 'text-muted line-through')}>{item.label}</p>
                          {item.hint && <p className="truncate text-xs text-muted">{item.hint}</p>}
                        </div>
                        {item.actionHref ? (
                          <Link href={item.actionHref} className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-muted transition hover:bg-elevated hover:text-fg" aria-label={`Open: ${item.label}`}>
                            <ChevronRight className="h-4 w-4" />
                          </Link>
                        ) : item.reminderTitle ? (
                          <button
                            type="button"
                            onClick={() => remind(event, item, prep.leaveByISO)}
                            disabled={pending.has(key)}
                            className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs font-semibold text-muted transition hover:bg-elevated hover:text-fg disabled:opacity-50"
                          >
                            <Bell className="h-3.5 w-3.5" /> Remind
                          </button>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
