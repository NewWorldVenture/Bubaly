import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Activity, CheckCircle2, Timer, TrendingDown, Rocket, Zap, CalendarCheck, Sun } from 'lucide-react';
import { requireUserContext, isSuperAdmin } from '@/lib/supabase/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { PageHeader } from '@/components/app/page-header';
import { SectionCard, MiniEmpty, MiniError, StatTile } from '@/components/family/shell';
import {
  summarizeOnboardingFunnel, formatRate, formatDuration, ONBOARDING_STEPS,
  type OnboardingEventLike,
} from '@/lib/analytics/onboarding';
import { summarizeActivation, type ActivationEventLike } from '@/lib/analytics/activation';
import { loadActivationEvents, loadOnboardingEvents } from '@/lib/analytics/onboarding-server';
import { ThirtyMinuteSummary } from '@/components/analytics/thirty-minute-summary';
import { getTranslations } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('dashboardOnboardingFunnel.onboardingFunnel'), robots: { index: false } };
}
export const dynamic = 'force-dynamic';

export default async function OnboardingFunnelPage() {
  await requireUserContext();
  // Cross-user pre-family telemetry — admin-only, read via the service role.
  if (!(await isSuperAdmin())) notFound();
  const t = await getTranslations();

  const supabase = createServiceClient();
  const cutoff = new Date();
  const [{ data, error: funnelError }, { data: actData, error: actError }] = await Promise.all([
    loadOnboardingEvents(supabase, cutoff), loadActivationEvents(supabase, cutoff),
  ]);

  const funnel = summarizeOnboardingFunnel((data ?? []) as OnboardingEventLike[]);
  const stepLabel = (key: string | null) =>
    ONBOARDING_STEPS.find((s) => s.key === key)?.label ?? key ?? '—';

  // TTFV / activation — the value half of the funnel (T10).
  const activation = summarizeActivation((actData ?? []) as ActivationEventLike[]);

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('dashboardOnboardingFunnel.onboardingFunnel')}
        description={t('thirtyMinute.funnelDescription')}
      />

      {!funnelError && <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label={t('dashboardOnboardingFunnel.sessionsStarted')} value={funnel.startedSessions} icon={Activity} accent="bg-blue-600" />
        <StatTile label={t('dashboardOnboardingFunnel.completed')} value={funnel.completedSessions} icon={CheckCircle2} accent="bg-emerald-600" />
        <StatTile label={t('dashboardOnboardingFunnel.completion')} value={formatRate(funnel.completionRate)} icon={Timer} accent="bg-violet-600" />
        <StatTile label={t('dashboardOnboardingFunnel.medianTime')} value={formatDuration(funnel.medianCompletionMs)} icon={Timer} accent="bg-amber-600" />
      </div>}

      <SectionCard title={t('dashboardOnboardingFunnel.stepByStepFunnel')}>
        {funnelError ? (
          <MiniError text={t('onboardingFunnel.couldnTLoadOnboardingTelemetry')} />
        ) : funnel.startedSessions === 0 ? (
          <MiniEmpty icon={Activity} text={t('onboardingFunnel.noOnboardingActivityYet')} />
        ) : (
          <ul className="space-y-3">
            {funnel.steps.map((s) => (
              <li key={s.key}>
                <div className="mb-1 flex items-center justify-between text-sm">
                  <span className="font-medium">
                    {s.label}
                    {s.key === funnel.biggestDropStep && (
                      <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-rose-500/10 px-2 py-0.5 text-[10px] text-rose-300">
                        <TrendingDown className="size-3" />{' '}{t('onboardingFunnel.biggestDrop')}</span>
                    )}
                  </span>
                  <span className="text-muted">
                    {s.reached} · {formatRate(s.reachRate)}
                    {s.droppedFromPrev > 0 && <span className="ml-2 text-rose-300">−{s.droppedFromPrev}</span>}
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-muted/10">
                  <div className="h-full rounded-full bg-brand" style={{ width: `${Math.round(s.reachRate * 100)}%` }} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      {!funnelError && funnel.biggestDropStep && (
        <p className="text-sm text-muted">
          {t('dashboardOnboardingFunnel.mostUsersWhoLeaveDoSo')} <strong>{stepLabel(funnel.biggestDropStep)}</strong> {t('dashboardOnboardingFunnel.theHighestLeverageStepToSimplify')}
        </p>
      )}

      {/* ── Time to First Value (T10) ─────────────────────────────────────── */}
      {!actError && <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label={t('dashboardOnboardingFunnel.ttfvMedian')} value={formatDuration(activation.ttfvMedianMs)} icon={Zap} accent="bg-fuchsia-600" />
        <StatTile label={t('dashboardOnboardingFunnel.ttfvP90')} value={formatDuration(activation.ttfvP90Ms)} icon={Timer} accent="bg-fuchsia-700" />
        <StatTile label={t('dashboardOnboardingFunnel.activationRate')} value={formatRate(activation.activationRate)} icon={Rocket} accent="bg-emerald-600" />
        <StatTile label={t('dashboardOnboardingFunnel.newFamilies')} value={activation.cohorts} icon={Activity} accent="bg-blue-600" />
      </div>}

      {!actError && <ThirtyMinuteSummary kind="activation" rate={activation.under30MinRate === null ? null : activation.under30MinRate * 100}
        within={activation.under30MinCohorts} timed={activation.timedValueCohorts} untimed={activation.untimedValueCohorts} t={t} />}

      <SectionCard title={t('dashboardOnboardingFunnel.timeToFirstValue')}>
        {actError ? (
          <MiniError text={t('onboardingFunnel.couldnTLoadActivationTelemetry')} />
        ) : activation.cohorts === 0 ? (
          <MiniEmpty icon={Rocket} text={t('onboardingFunnel.noActivationEventsYetValue')} />
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <StatTile label={t('dashboardOnboardingFunnel.calendarImportedSession1')} value={formatRate(activation.session1.calendarImportRate)} icon={CalendarCheck} accent="bg-indigo-600" />
              <StatTile label={t('dashboardOnboardingFunnel.firstBriefingSession1')} value={formatRate(activation.session1.firstBriefRate)} icon={Sun} accent="bg-amber-600" />
              <StatTile label={t('dashboardOnboardingFunnel.firstOutcomeSession1')} value={formatRate(activation.session1.firstOutcomeRate)} icon={Rocket} accent="bg-emerald-600" />
            </div>
            <ul className="space-y-3">
              {activation.milestoneReach.map((m) => (
                <li key={m.key}>
                  <div className="mb-1 flex items-center justify-between text-sm">
                    <span className="font-medium">{m.label}</span>
                    <span className="text-muted">{m.cohorts} · {formatRate(m.rate)}</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-muted/10">
                    <div className="h-full rounded-full bg-fuchsia-500" style={{ width: `${Math.round(m.rate * 100)}%` }} />
                  </div>
                </li>
              ))}
            </ul>
            <p className="text-sm text-muted">
              {t('thirtyMinute.activationMethod')}
            </p>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
