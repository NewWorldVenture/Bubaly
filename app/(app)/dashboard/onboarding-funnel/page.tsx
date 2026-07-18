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

export const metadata: Metadata = { title: 'Onboarding Funnel' };
export const dynamic = 'force-dynamic';

export default async function OnboardingFunnelPage() {
  await requireUserContext();
  // Cross-user pre-family telemetry — admin-only, read via the service role.
  if (!(await isSuperAdmin())) notFound();

  const supabase = createServiceClient();
  const { data, error: funnelError } = await supabase
    .from('onboarding_events')
    .select('session_id, step, phase, duration_ms, created_at')
    .order('created_at', { ascending: false })
    .limit(10000);

  const funnel = summarizeOnboardingFunnel((data ?? []) as OnboardingEventLike[]);
  const stepLabel = (key: string | null) =>
    ONBOARDING_STEPS.find((s) => s.key === key)?.label ?? key ?? '—';

  // TTFV / activation — the value half of the funnel (T10).
  const { data: actData, error: actError } = await supabase
    .from('activation_events')
    .select('session_id, milestone, session_index, ms_since_signup, created_at')
    .order('created_at', { ascending: false })
    .limit(20000);
  const activation = summarizeActivation((actData ?? []) as ActivationEventLike[]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Onboarding Funnel"
        description="Pre-family telemetry: where new users reach, drop off, and how long sign-up takes. Real onboarding_events, all sessions."
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="Sessions started" value={funnel.startedSessions} icon={Activity} accent="bg-blue-600" />
        <StatTile label="Completed" value={funnel.completedSessions} icon={CheckCircle2} accent="bg-emerald-600" />
        <StatTile label="Completion" value={formatRate(funnel.completionRate)} icon={Timer} accent="bg-violet-600" />
        <StatTile label="Median time" value={formatDuration(funnel.medianCompletionMs)} icon={Timer} accent="bg-amber-600" />
      </div>

      <SectionCard title="Step-by-step funnel">
        {funnelError ? (
          <MiniError text="Couldn’t load onboarding telemetry. Refresh to try again." />
        ) : funnel.startedSessions === 0 ? (
          <MiniEmpty icon={Activity} text="No onboarding activity yet." />
        ) : (
          <ul className="space-y-3">
            {funnel.steps.map((s) => (
              <li key={s.key}>
                <div className="mb-1 flex items-center justify-between text-sm">
                  <span className="font-medium">
                    {s.label}
                    {s.key === funnel.biggestDropStep && (
                      <span className="ml-2 inline-flex items-center gap-1 rounded-full bg-rose-500/10 px-2 py-0.5 text-[10px] text-rose-300">
                        <TrendingDown className="size-3" /> biggest drop
                      </span>
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

      {funnel.biggestDropStep && (
        <p className="text-sm text-muted">
          Most users who leave do so at <strong>{stepLabel(funnel.biggestDropStep)}</strong> — the highest-leverage step to simplify.
        </p>
      )}

      {/* ── Time to First Value (T10) ─────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile label="TTFV (median)" value={formatDuration(activation.ttfvMedianMs)} icon={Zap} accent="bg-fuchsia-600" />
        <StatTile label="TTFV (p90)" value={formatDuration(activation.ttfvP90Ms)} icon={Timer} accent="bg-fuchsia-700" />
        <StatTile label="Activation rate" value={formatRate(activation.activationRate)} icon={Rocket} accent="bg-emerald-600" />
        <StatTile label="New families" value={activation.cohorts} icon={Activity} accent="bg-blue-600" />
      </div>

      <SectionCard title="Time to First Value">
        {actError ? (
          <MiniError text="Couldn’t load activation telemetry. Refresh to try again." />
        ) : activation.cohorts === 0 ? (
          <MiniEmpty icon={Rocket} text="No activation events yet — value milestones fire once a family views an outcome, briefing, or imports a calendar." />
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <StatTile label="Calendar imported · session 1" value={formatRate(activation.session1.calendarImportRate)} icon={CalendarCheck} accent="bg-indigo-600" />
              <StatTile label="First briefing · session 1" value={formatRate(activation.session1.firstBriefRate)} icon={Sun} accent="bg-amber-600" />
              <StatTile label="First outcome · session 1" value={formatRate(activation.session1.firstOutcomeRate)} icon={Rocket} accent="bg-emerald-600" />
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
              TTFV is measured from sign-up to the first outcome a family views. It&rsquo;s the number every onboarding change is trying to move.
            </p>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
