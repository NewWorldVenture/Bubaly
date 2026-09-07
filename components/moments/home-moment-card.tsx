'use client';

// The single most imminent "moment", surfaced on Home so the family sees — and
// can ACT on — the next-best-action without opening anything. Reuses the pure
// prep engine. Renders nothing when there's no upcoming event that needs prep,
// so Home stays calm.

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Sparkles, Clock, CloudSun, Backpack, ShoppingCart, PiggyBank, Stethoscope,
  Camera, CalendarDays, ChevronRight, Bell, Check, Loader2, AlertTriangle,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { useToast } from '@/components/ui/toast';
import type { Tables } from '@/lib/database.types';
import { buildMomentPrep, momentWhen, type PrepDomain, type MomentEvent } from '@/lib/moments/prep';
import { upcomingBirthdayEvents } from '@/lib/moments/birthdays';
import { weatherAdvisory, dayKey } from '@/lib/moments/weather';
import { reminderTimeFor } from '@/lib/moments/reminders';
import { findOverlaps } from '@/lib/moments/conflicts';
import { useDefaultForecast } from '@/components/moments/use-default-forecast';
import { createMomentReminderAction } from '@/app/(app)/dashboard/moment-actions';
import { useTranslations } from '@/components/i18n/locale-provider';

type Event = Tables<'calendar_events'>;

const DOMAIN_ICON: Record<PrepDomain, typeof Clock> = {
  time: Clock, weather: CloudSun, packing: Backpack, shopping: ShoppingCart,
  budget: PiggyBank, health: Stethoscope, photo: Camera, calendar: CalendarDays,
};

// Only surface a moment that's genuinely near-term (within ~36h), so Home shows
// "what to get ready for now", not something a week out.
const HORIZON_MS = 36 * 3600 * 1000;

export function HomeMomentCard() {
  const t = useTranslations();
  const { familyId, members } = useApp();
  const { success, error: toastError } = useToast();
  const nowISO = useMemo(() => new Date().toISOString(), []);
  const wxByDate = useDefaultForecast(familyId);
  const [remindState, setRemindState] = useState<'idle' | 'saving' | 'done'>('idle');

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

  // The single best reminder to offer inline: the leave-by time, else the first
  // step that can become a reminder (nudged the evening before / 2h out).
  const primaryReminder = useMemo(() => {
    if (!moment) return null;
    const { event, prep } = moment;
    if (prep.leaveByISO) {
      return { title: `Leave for ${event.title}`, at: reminderTimeFor({ domain: 'time', stepId: 'leave-by', eventStartsAtISO: event.starts_at, leaveByISO: prep.leaveByISO }) };
    }
    const step = prep.items.find((i) => i.reminderTitle);
    if (!step) return null;
    return { title: step.reminderTitle as string, at: reminderTimeFor({ domain: step.domain, stepId: step.id, eventStartsAtISO: event.starts_at }) };
  }, [moment]);

  if (!moment) return null;
  const { event, prep } = moment;
  const steps = prep.items.slice(0, 4);
  // Warn on Home too if this moment double-books with another event.
  const clash = findOverlaps(rows ?? [])[event.id];

  async function setReminder() {
    if (!primaryReminder || remindState !== 'idle') return;
    setRemindState('saving');
    const res = await createMomentReminderAction({
      familyId, title: primaryReminder.title, remindAtISO: primaryReminder.at, eventId: event.id,
    });
    if (!res.ok) { setRemindState('idle'); toastError(res.error ?? 'Could not set reminder'); return; }
    setRemindState('done');
    success(t('homeMomentCard.reminderSet'));
  }

  return (
    <div className="flex items-center gap-4 rounded-2xl border border-brand/30 bg-gradient-to-r from-brand/10 to-transparent p-4 sm:p-5">
      <Link href="/dashboard/moments" className="group flex min-w-0 flex-1 items-center gap-4" aria-label={`Get ready for ${event.title}`}>
        <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-brand/15 text-brand-text">
          <Sparkles className="h-6 w-6" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-brand-text">{t('homeMoment.getReady')}</span>
            <span className="text-xs font-medium text-muted">· {momentWhen(event.starts_at, event.all_day)}</span>
          </div>
          <p className="truncate text-sm font-bold sm:text-base">{event.title}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {clash?.length ? (
              <span className="inline-flex items-center gap-1 rounded-lg bg-amber-500/15 px-2 py-1 text-xs font-semibold text-amber-500">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                {t('homeMoment.overlaps')} {clash[0]}{clash.length > 1 ? ` +${clash.length - 1}` : ''}
              </span>
            ) : null}
            {prep.leaveByISO && (
              <span className="inline-flex items-center gap-1 rounded-lg bg-elevated px-2 py-1 text-xs font-semibold">
                <Clock className="h-3.5 w-3.5 text-brand-text" />
                {t('homeMoment.leave')} {new Date(prep.leaveByISO).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
              </span>
            )}
            {steps.filter((s) => s.domain !== 'time').slice(0, 3).map((s) => {
              const Icon = DOMAIN_ICON[s.domain];
              // Weather chip: show the real forecast advisory when we have one.
              const wxDay = s.domain === 'weather' ? wxByDate[dayKey(event.starts_at)] : undefined;
              const adv = wxDay ? weatherAdvisory(wxDay) : null;
              const label = adv ? adv.label : s.label;
              return (
                <span key={s.id} className="inline-flex items-center gap-1 rounded-lg bg-elevated px-2 py-1 text-xs text-muted">
                  <Icon className="h-3.5 w-3.5" /> {label}
                </span>
              );
            })}
          </div>
        </div>
      </Link>

      {/* One-tap action — set the reminder without leaving Home. */}
      {primaryReminder ? (
        <button
          type="button"
          onClick={setReminder}
          disabled={remindState !== 'idle'}
          aria-label={remindState === 'done' ? t('homeMomentCard.reminderSet') : `Remind me: ${primaryReminder.title}`}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-brand/40 bg-brand/10 px-3 py-2 text-xs font-semibold text-brand-text transition hover:bg-brand/15 disabled:opacity-60"
        >
          {remindState === 'saving' ? <Loader2 className="h-4 w-4 animate-spin" />
            : remindState === 'done' ? <Check className="h-4 w-4" />
            : <Bell className="h-4 w-4" />}
          <span className="hidden sm:inline">{remindState === 'done' ? t('homeMomentCard.reminderSet') : 'Remind me'}</span>
        </button>
      ) : (
        <Link href="/dashboard/moments" aria-label={t('homeMoment.openMoments')} className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-muted transition hover:text-brand-text">
          <ChevronRight className="h-5 w-5" />
        </Link>
      )}
    </div>
  );
}
