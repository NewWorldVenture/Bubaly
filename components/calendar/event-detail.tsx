'use client';

// components/calendar/event-detail.tsx — the composed schedule model for ONE
// event, on the event detail surface: its leave-by (real drive time when a
// departure plan was saved, the category buffer otherwise) and every driver,
// car, dinner, care and double-booking constraint the rest of the family's
// day puts on it. One tap goes to the module that resolves each.
//
// READ BOUNDARY: a failed read renders a retryable error, never an empty
// "no conflicts" line — that line is a claim, and one computed from missing
// rows would be false. The insight copy is rendered through `t(reasonKey,
// params)` so the fact the engine found reads in the family's language.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, CalendarClock, Car, ChefHat, ChevronRight, Clock, HeartHandshake, Users } from 'lucide-react';
import { eventScheduleInsightsAction, type EventScheduleInsightsResult } from '@/app/(app)/dashboard/calendar/actions';
import type { ScheduleInsightKind, ScheduleInsightSeverity } from '@/lib/schedule/intelligence';
import { ErrorState } from '@/components/ui/states';
import { useTranslations } from '@/components/i18n/locale-provider';
import { cn } from '@/lib/utils/cn';

type KindMeta = { kind: ScheduleInsightKind; label: string; labelKey: string; openLabel: string; openKey: string; icon: typeof Clock };

/** English label + catalogue key per insight kind; the component renders the key. */
const KIND_META: KindMeta[] = [
  { kind: 'leave_by', label: 'Leave-by', labelKey: 'eventDetail.kindLeaveBy', openLabel: 'Plan the drive', openKey: 'eventDetail.planTheDrive', icon: Clock },
  { kind: 'driver_conflict', label: 'Driver', labelKey: 'eventDetail.kindDriver', openLabel: 'Open Rides', openKey: 'eventDetail.openRides', icon: Users },
  { kind: 'driver_needed', label: 'Driver needed', labelKey: 'eventDetail.kindDriverNeeded', openLabel: 'Open Rides', openKey: 'eventDetail.openRides', icon: Users },
  { kind: 'vehicle_conflict', label: 'Car', labelKey: 'eventDetail.kindCar', openLabel: 'Open Rides', openKey: 'eventDetail.openRides', icon: Car },
  { kind: 'meal_timing', label: 'Dinner', labelKey: 'eventDetail.kindDinner', openLabel: 'Open Meals', openKey: 'eventDetail.openMeals', icon: ChefHat },
  { kind: 'care_gap', label: 'Care', labelKey: 'eventDetail.kindCare', openLabel: 'Open Sitters', openKey: 'eventDetail.openSitters', icon: HeartHandshake },
  { kind: 'double_booking', label: 'Double-booked', labelKey: 'eventDetail.kindDoubleBooking', openLabel: 'Open Calendar', openKey: 'eventDetail.openCalendar', icon: CalendarClock },
];
const META_BY_KIND = Object.fromEntries(KIND_META.map((m) => [m.kind, m])) as Record<ScheduleInsightKind, KindMeta>;

const SEVERITY_CLS: Record<ScheduleInsightSeverity, string> = {
  urgent: 'border-danger/40 bg-danger/5 text-danger',
  warn: 'border-amber-500/40 bg-amber-500/5 text-amber-600',
  info: 'border-border bg-surface/40 text-fg',
};

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: Extract<EventScheduleInsightsResult, { ok: true }> };

export function EventScheduleInsights({ eventId }: { eventId: string }) {
  const t = useTranslations();
  const [state, setState] = useState<State>({ status: 'loading' });

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const res = await eventScheduleInsightsAction(eventId);
      if (!res.ok) { setState({ status: 'error', message: res.error }); return; }
      setState({ status: 'ready', data: res });
    } catch {
      setState({ status: 'error', message: t('eventDetail.couldNotCheckThisEvent') });
    }
  }, [eventId, t]);

  useEffect(() => { void load(); }, [load]);

  return (
    <section aria-label={t('eventDetail.scheduleCheck')} className="space-y-2">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">{t('eventDetail.scheduleCheck')}</p>
      {state.status === 'loading' && (
        <p className="text-sm text-muted" role="status">{t('eventDetail.checkingTheFamilySchedule')}</p>
      )}
      {state.status === 'error' && (
        <ErrorState message={state.message} onRetry={() => void load()} />
      )}
      {state.status === 'ready' && state.data.insights.length === 0 && (
        <p className="text-sm text-muted">{t('eventDetail.noConflictsFound')}</p>
      )}
      {state.status === 'ready' && state.data.insights.length > 0 && (
        <ul className="space-y-1.5">
          {state.data.insights.map((i) => {
            const meta = META_BY_KIND[i.kind];
            const Icon = i.severity === 'urgent' ? AlertTriangle : meta.icon;
            return (
              <li key={i.id} className={cn('flex items-center gap-3 rounded-xl border px-3 py-2', SEVERITY_CLS[i.severity])}>
                <Icon className="h-4 w-4 shrink-0" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="text-[10px] font-semibold uppercase tracking-wide opacity-80">{t(meta.labelKey)}</p>
                  <p className="text-sm">{t(i.reasonKey, i.params)}</p>
                  {i.kind === 'leave_by' && state.data.leaveBy && (
                    <p className="text-xs opacity-80">
                      {state.data.leaveBy.source === 'drive_time' ? t('eventDetail.fromASavedDeparturePlan') : t('eventDetail.estimatedFromTheEventType')}
                    </p>
                  )}
                </div>
                <Link href={i.href} className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold underline-offset-2 hover:underline">
                  {t(meta.openKey)} <ChevronRight className="h-3.5 w-3.5" aria-hidden />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
