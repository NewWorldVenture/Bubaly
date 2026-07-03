'use client';

// The single most imminent "moment", surfaced on Home so the family sees the
// next-best-action without opening anything. Reuses the pure prep engine. Renders
// nothing when there's no upcoming event that needs prep, so Home stays calm.

import { useMemo } from 'react';
import Link from 'next/link';
import {
  Sparkles, Clock, CloudSun, Backpack, ShoppingCart, PiggyBank, Stethoscope,
  Camera, CalendarDays, ChevronRight,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import type { Tables } from '@/lib/database.types';
import { buildMomentPrep, momentWhen, type PrepDomain, type MomentEvent } from '@/lib/moments/prep';
import { upcomingBirthdayEvents } from '@/lib/moments/birthdays';

type Event = Tables<'calendar_events'>;

const DOMAIN_ICON: Record<PrepDomain, typeof Clock> = {
  time: Clock, weather: CloudSun, packing: Backpack, shopping: ShoppingCart,
  budget: PiggyBank, health: Stethoscope, photo: Camera, calendar: CalendarDays,
};

// Only surface a moment that's genuinely near-term (within ~36h), so Home shows
// "what to get ready for now", not something a week out.
const HORIZON_MS = 36 * 3600 * 1000;

export function HomeMomentCard() {
  const { familyId, members } = useApp();
  const nowISO = useMemo(() => new Date().toISOString(), []);

  const { data: rows } = useRealtimeQuery<Event>({
    table: 'calendar_events', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('calendar_events').select('*')
      .eq('family_id', familyId).gte('starts_at', nowISO)
      .order('starts_at', { ascending: true }).limit(3),
  });

  const moment = useMemo(() => {
    // Merge real events with any birthday landing today/tomorrow, so Home's
    // banner can surface "Mia turns 8 tomorrow" just like the Moments page.
    const evs: MomentEvent[] = (rows ?? []).map((e) => ({
      id: e.id, title: e.title, category: e.category, location: e.location,
      starts_at: e.starts_at, all_day: e.all_day, description: e.description,
    }));
    const merged = [...evs, ...upcomingBirthdayEvents(members, new Date(), 2)]
      .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
    for (const e of merged) {
      if (new Date(e.starts_at).getTime() - Date.now() > HORIZON_MS) break;
      const prep = buildMomentPrep(e);
      if (prep.items.length > 0) return { event: e, prep };
    }
    return null;
  }, [rows, members]);

  if (!moment) return null;
  const { event, prep } = moment;
  const steps = prep.items.slice(0, 4);

  return (
    <Link
      href="/dashboard/moments"
      className="group flex items-center gap-4 rounded-2xl border border-brand/30 bg-gradient-to-r from-brand/10 to-transparent p-4 transition hover:border-brand/50 hover:from-brand/15 sm:p-5"
    >
      <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-brand/15 text-brand">
        <Sparkles className="h-6 w-6" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-brand">Get ready</span>
          <span className="text-xs font-medium text-muted">· {momentWhen(event.starts_at, event.all_day)}</span>
        </div>
        <p className="truncate text-sm font-bold sm:text-base">{event.title}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {prep.leaveByISO && (
            <span className="inline-flex items-center gap-1 rounded-lg bg-elevated px-2 py-1 text-xs font-semibold">
              <Clock className="h-3.5 w-3.5 text-brand" />
              Leave {new Date(prep.leaveByISO).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
            </span>
          )}
          {steps.filter((s) => s.domain !== 'time').slice(0, 3).map((s) => {
            const Icon = DOMAIN_ICON[s.domain];
            return (
              <span key={s.id} className="inline-flex items-center gap-1 rounded-lg bg-elevated px-2 py-1 text-xs text-muted">
                <Icon className="h-3.5 w-3.5" /> {s.label}
              </span>
            );
          })}
        </div>
      </div>
      <ChevronRight className="h-5 w-5 shrink-0 text-muted transition group-hover:translate-x-0.5 group-hover:text-brand" />
    </Link>
  );
}
