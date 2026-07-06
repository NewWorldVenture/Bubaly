import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Activity, CheckCircle2, Timer, TrendingDown } from 'lucide-react';
import { requireUserContext, isSuperAdmin } from '@/lib/supabase/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { PageHeader } from '@/components/app/page-header';
import { SectionCard, MiniEmpty, StatTile } from '@/components/family/shell';
import {
  summarizeOnboardingFunnel, formatRate, formatDuration, ONBOARDING_STEPS,
  type OnboardingEventLike,
} from '@/lib/analytics/onboarding';

export const metadata: Metadata = { title: 'Onboarding Funnel' };
export const dynamic = 'force-dynamic';

export default async function OnboardingFunnelPage() {
  await requireUserContext();
  // Cross-user pre-family telemetry — admin-only, read via the service role.
  if (!(await isSuperAdmin())) notFound();

  const supabase = createServiceClient();
  const { data } = await supabase
    .from('onboarding_events')
    .select('session_id, step, phase, duration_ms, created_at')
    .order('created_at', { ascending: false })
    .limit(10000);

  const funnel = summarizeOnboardingFunnel((data ?? []) as OnboardingEventLike[]);
  const stepLabel = (key: string | null) =>
    ONBOARDING_STEPS.find((s) => s.key === key)?.label ?? key ?? '—';

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
        {funnel.startedSessions === 0 ? (
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
    </div>
  );
}
