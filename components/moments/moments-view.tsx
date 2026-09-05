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
  GraduationCap, Trees, CalendarDays, Plus, AlertTriangle,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { weatherAdvisory, dayKey } from '@/lib/moments/weather';
import { useDefaultForecast } from '@/components/moments/use-default-forecast';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/app/page-header';
import { SkeletonList, EmptyState } from '@/components/ui/states';
import { cn } from '@/lib/utils/cn';
import type { Tables } from '@/lib/database.types';
import {
  buildMomentPrep, momentWhen, type PrepDomain, type PrepItem, type MomentCategory, type MomentEvent,
} from '@/lib/moments/prep';
import { upcomingBirthdayEvents } from '@/lib/moments/birthdays';
import { findOverlaps } from '@/lib/moments/conflicts';
import { reminderTimeFor } from '@/lib/moments/reminders';
import { groupMoments } from '@/lib/moments/grouping';
import { summarizeMoments } from '@/lib/moments/summary';
import {
  loadMomentPrep, setMomentPrepDoneAction, createMomentReminderAction, addMomentGroceryAction,
  removeMomentGroceryAction,
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
  const { familyId, members } = useApp();
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
  // Real forecast for the family's default location — so weather-sensitive moments
  // say exactly what to pack ("Rain likely 70% — umbrellas") instead of a generic
  // "check the forecast". Shared with the Home banner via the same hook.
  const wxByDate = useDefaultForecast(familyId);

  useEffect(() => { loadMomentPrep().then(setDone).catch(() => { /* first-paint best effort */ }); }, []);

  // Real calendar events + synthetic upcoming-birthday moments, merged by time.
  // Birthdays live on family_members (not the calendar), so this is the only place
  // they become anticipated moments — and they reuse the same celebration prep.
  const moments = useMemo(() => {
    const evs: MomentEvent[] = (rows ?? []).map((e) => ({
      id: e.id, title: e.title, category: e.category, location: e.location,
      starts_at: e.starts_at, all_day: e.all_day, description: e.description,
    }));
    const all = [...evs, ...upcomingBirthdayEvents(members, new Date(), 30)]
      .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
    return all.map((e) => ({ event: e, prep: buildMomentPrep(e) }))
      .filter((m) => m.prep.items.length > 0);
  }, [rows, members]);

  // Real double-bookings among the upcoming timed events (before they surprise you).
  const clashes = useMemo(() => findOverlaps(rows ?? []), [rows]);
  // One-glance tally for the summary strip.
  const summary = useMemo(() => summarizeMoments(moments, done, clashes), [moments, done, clashes]);

  async function toggle(eventId: string, itemId: string) {
    const current = done[eventId] ?? [];
    const next = current.includes(itemId) ? current.filter((i) => i !== itemId) : [...current, itemId];
    const prev = done;
    setDone({ ...done, [eventId]: next });
    const res = await setMomentPrepDoneAction({ eventId, doneIds: next });
    if (!res.ok) { setDone(prev); toastError(res.error ?? 'Could not save'); }
  }

  async function addToList(event: MomentEvent, item: PrepItem) {
    const key = `${event.id}:${item.id}`;
    if (pending.has(key) || !item.groceryItems?.length) return;
    setPending((p) => new Set(p).add(key));
    const res = await addMomentGroceryAction({ familyId, items: item.groceryItems });
    setPending((p) => { const n = new Set(p); n.delete(key); return n; });
    if (!res.ok) return toastError(res.error ?? 'Could not add to list');
    if (res.added && res.ids?.length) {
      const ids = res.ids;
      success(`Added ${res.added} to your grocery list`, {
        label: 'Undo',
        onClick: () => {
          void removeMomentGroceryAction({ ids }).then((r) => {
            if (!r.ok) toastError(r.error ?? 'Could not undo');
            else if ((done[event.id] ?? []).includes(item.id)) void toggle(event.id, item.id);
          });
        },
      });
    } else {
      success('Already on your list');
    }
    if (!(done[event.id] ?? []).includes(item.id)) void toggle(event.id, item.id);
  }

  async function remind(event: MomentEvent, item: PrepItem, leaveByISO: string | null) {
    const key = `${event.id}:${item.id}`;
    if (pending.has(key)) return;
    setPending((p) => new Set(p).add(key));
    // Fire at a sensible per-domain lead time (leave-by → leave time, packing →
    // night before, shopping → a couple days out, photo → at the event).
    const remindAtISO = reminderTimeFor({ domain: item.domain, stepId: item.id, eventStartsAtISO: event.starts_at, leaveByISO });
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
        description="Your next events, already prepped. Bubaly lines up everything each one needs — you just tap."
      />

      {!loading && moments.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-xs font-semibold">
          <span className="rounded-full bg-elevated px-2.5 py-1 text-muted">{summary.total} upcoming</span>
          {summary.needPrep > 0 && (
            <span className="rounded-full bg-brand/15 px-2.5 py-1 text-brand-text">{summary.needPrep} need prep</span>
          )}
          {summary.ready > 0 && (
            <span className="rounded-full bg-emerald-500/15 px-2.5 py-1 text-emerald-500">{summary.ready} ready</span>
          )}
          {summary.conflicts > 0 && (
            <span className="rounded-full bg-amber-500/15 px-2.5 py-1 text-amber-500">{summary.conflicts} conflict{summary.conflicts === 1 ? '' : 's'}</span>
          )}
        </div>
      )}

      {loading ? <SkeletonList /> : moments.length === 0 ? (
        <EmptyState
          icon={Sparkles}
          title="Nothing on the horizon"
          description="When your family has upcoming events, Bubaly will assemble the prep for each one here."
          action={<Link href="/dashboard/calendar" className="btn-cta">Open Calendar</Link>}
        />
      ) : (
        <div className="space-y-6">
          {groupMoments(moments, (m) => m.event.starts_at).map((group) => (
          <section key={group.bucket}>
            <h2 className="mb-3 flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-muted">
              {group.label}
              <span className="rounded-full bg-elevated px-1.5 text-[11px] font-semibold text-muted/70">{group.items.length}</span>
            </h2>
            <div className="grid gap-4 lg:grid-cols-2">
          {group.items.map(({ event, prep }) => {
            const CatIcon = CAT_ICON[prep.category];
            const doneIds = done[event.id] ?? [];
            const total = prep.items.length;
            const complete = prep.items.filter((i) => doneIds.includes(i.id)).length;
            const allReady = complete === total;
            return (
              <section key={event.id} className="flex flex-col rounded-2xl border border-border bg-surface/40 p-4 sm:p-5">
                <div className="mb-3 flex items-start gap-3">
                  <span className={cn('grid h-11 w-11 shrink-0 place-items-center rounded-xl', allReady ? 'bg-emerald-500/15 text-emerald-400' : 'bg-brand/15 text-brand-text')}>
                    {allReady ? <Check className="h-5 w-5" /> : <CatIcon className="h-5 w-5" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="rounded-full bg-elevated px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted">{CAT_LABEL[prep.category]}</span>
                      <span className="text-xs font-medium text-brand-text">{momentWhen(event.starts_at, event.all_day)}</span>
                    </div>
                    <h2 className="mt-0.5 truncate text-base font-bold">{event.title}</h2>
                    {event.location && <p className="truncate text-xs text-muted">{event.location}</p>}
                    {clashes[event.id]?.length ? (
                      <p className="mt-1 inline-flex items-center gap-1 rounded-lg bg-amber-500/15 px-2 py-1 text-[11px] font-semibold text-amber-500">
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                        Overlaps {clashes[event.id][0]}{clashes[event.id].length > 1 ? ` +${clashes[event.id].length - 1}` : ''}
                      </p>
                    ) : null}
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
                    // Weather step: replace the generic prompt with the real forecast
                    // advisory for the moment's day, when we have one.
                    const wxDay = item.domain === 'weather' ? wxByDate[dayKey(event.starts_at)] : undefined;
                    const adv = wxDay ? weatherAdvisory(wxDay) : null;
                    const label = adv ? adv.label : item.label;
                    const hint = adv ? adv.hint : item.hint;
                    return (
                      <li key={item.id} className={cn('flex items-center gap-3 rounded-xl border px-3 py-2.5 transition', isDone ? 'border-border/50 bg-surface/20' : 'border-border bg-surface/40')}>
                        <button
                          type="button"
                          onClick={() => toggle(event.id, item.id)}
                          aria-pressed={isDone}
                          aria-label={isDone ? `Mark "${label}" not done` : `Mark "${label}" done`}
                          className={cn('grid h-6 w-6 shrink-0 place-items-center rounded-md border-2 transition',
                            isDone ? 'border-emerald-500 bg-emerald-500 text-white' : 'border-border text-transparent hover:border-brand')}
                        >
                          <Check className="h-3.5 w-3.5" />
                        </button>
                        <span className={cn('grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-elevated', isDone ? 'text-muted/50' : 'text-brand-text')}>
                          <DIcon className="h-4 w-4" />
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className={cn('truncate text-sm font-medium', isDone && 'text-muted line-through')}>{label}</p>
                          {hint && <p className="truncate text-xs text-muted">{hint}</p>}
                        </div>
                        {item.groceryItems?.length ? (
                          <button
                            type="button"
                            onClick={() => addToList(event, item)}
                            disabled={pending.has(key)}
                            className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-brand/40 bg-brand/5 px-2.5 py-1.5 text-xs font-semibold text-brand-text transition hover:bg-brand/10 disabled:opacity-50"
                          >
                            <Plus className="h-3.5 w-3.5" /> Add {item.groceryItems.length}
                          </button>
                        ) : item.reminderTitle ? (
                          <button
                            type="button"
                            onClick={() => remind(event, item, prep.leaveByISO)}
                            disabled={pending.has(key)}
                            className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs font-semibold text-muted transition hover:bg-elevated hover:text-fg disabled:opacity-50"
                          >
                            <Bell className="h-3.5 w-3.5" /> Remind
                          </button>
                        ) : item.actionHref ? (
                          <Link href={item.actionHref} className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-muted transition hover:bg-elevated hover:text-fg" aria-label={`Open: ${item.label}`}>
                            <ChevronRight className="h-4 w-4" />
                          </Link>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
            </div>
          </section>
          ))}
        </div>
      )}
    </div>
  );
}
