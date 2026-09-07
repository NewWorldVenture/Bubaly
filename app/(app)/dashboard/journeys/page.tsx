import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Activity, CheckCircle2, Timer } from 'lucide-react';
import { requireUserContext, isSuperAdmin } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { PageHeader } from '@/components/app/page-header';
import { SectionCard, MiniEmpty, MiniError, StatTile } from '@/components/family/shell';
import {
  summarizeJourneys, formatDuration, formatRate,
  type JourneyEventLike,
} from '@/lib/analytics/journey';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Journey Analytics' };
export const dynamic = 'force-dynamic';

export default async function JourneysPage() {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  // Raw product telemetry is an admin-only view.
  if (!(await isSuperAdmin())) notFound();

  const supabase = await createServer();
  const { data, error } = await supabase
    .from('journey_events')
    .select('journey, phase, step, duration_ms, session_id, created_at')
    .eq('family_id', ctx.active.familyId)
    .order('created_at', { ascending: false })
    .limit(5000);

  // A failed telemetry read must not masquerade as "no events" — that would tell
  // the operator onboarding traffic is zero when the query actually errored.
  const events = (data ?? []) as JourneyEventLike[];
  const rows = summarizeJourneys(events);
  const totalStarts = rows.reduce((a, r) => a + r.starts, 0);
  const totalCompletions = rows.reduce((a, r) => a + r.completions, 0);
  const overallRate = totalStarts > 0 ? totalCompletions / totalStarts : 0;

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('dashboardJourneys.journeyAnalytics')}
        description={t('journeys.realCompletionRatesAndTimes')}
      />

      <div className="grid grid-cols-3 gap-3">
        <StatTile label={t('dashboardJourneys.journeysStarted')} value={totalStarts} icon={Activity} accent="bg-blue-600" />
        <StatTile label={t('dashboardJourneys.completed')} value={totalCompletions} icon={CheckCircle2} accent="bg-emerald-600" />
        <StatTile label={t('dashboardJourneys.completion')} value={formatRate(overallRate)} icon={Timer} accent="bg-violet-600" />
      </div>

      <SectionCard title={t('dashboardJourneys.perJourneyMedians')} description="Measured from journey_events (0124) — no estimates.">
        {error ? (
          <MiniError text={t('journeys.couldnTLoadJourneyTelemetry')} />
        ) : rows.length === 0 ? (
          <MiniEmpty icon={Activity} text={t('journeys.noJourneyEventsYetUse')} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                  <th className="py-2 pr-3 font-medium">{t('dashboardJourneys.journey')}</th>
                  <th className="py-2 px-3 font-medium">{t('dashboardJourneys.starts')}</th>
                  <th className="py-2 px-3 font-medium">{t('dashboardJourneys.completed')}</th>
                  <th className="py-2 px-3 font-medium">{t('dashboardJourneys.rate')}</th>
                  <th className="py-2 px-3 font-medium">{t('dashboardJourneys.medianTime')}</th>
                  <th className="py-2 pl-3 font-medium">{t('dashboardJourneys.medianSteps')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.journey} className="border-b border-border/50">
                    <td className="py-2.5 pr-3 font-medium text-fg">{r.label}</td>
                    <td className="py-2.5 px-3 tabular-nums text-muted">{r.starts}</td>
                    <td className="py-2.5 px-3 tabular-nums text-muted">{r.completions}</td>
                    <td className="py-2.5 px-3 tabular-nums">
                      <span className={r.completionRate >= 0.8 ? 'text-emerald-300' : r.completionRate >= 0.5 ? 'text-amber-300' : 'text-rose-300'}>
                        {formatRate(r.completionRate)}
                      </span>
                    </td>
                    <td className="py-2.5 px-3 tabular-nums text-muted">{formatDuration(r.medianDurationMs)}</td>
                    <td className="py-2.5 pl-3 tabular-nums text-muted">{r.medianSteps ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <p className="text-xs text-muted">
        {t('journeys.scopeThisFamilyOnly')}{' '}<code className="rounded bg-elevated px-1">useJourney(&apos;key&apos;)</code>.
      </p>
    </div>
  );
}
