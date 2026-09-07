import type { Metadata } from 'next';
import Link from 'next/link';
import { BarChart3, CheckCircle2, CreditCard, GraduationCap, Trophy, HeartPulse, Gauge } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { gatherSignalsResult } from '@/lib/family/signals';
import { PageHeader } from '@/components/app/page-header';
import { StatTile, SectionCard, ScoreRing, LevelBadge } from '@/components/family/shell';
import { ErrorState } from '@/components/ui/states';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'reports.familyReports' };
export const dynamic = 'force-dynamic';

async function ReadFailure() {
  const t = await getTranslations();
  return (
    <div className="mx-auto max-w-2xl space-y-4 px-4 py-6">
      <h1 className="text-2xl font-bold tracking-tight">{t('reports.familyReports')}</h1>
      <ErrorState message="Could not load family reports from Supabase. Refresh and try again." />
      <Link href="/family/reports" className="text-sm font-medium text-brand-text underline">{t('reports.refreshFamilyReports')}</Link>
    </div>
  );
}

export default async function FamilyReportsPage() {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const result = await gatherSignalsResult(ctx.active.familyId);
  if (result.error || !result.data) {
    console.error('[family-reports] required read failed', result.error);
    return <ReadFailure />;
  }
  const { stress, completion, counts } = result.data;
  const taskRate = counts.totalTasks > 0 ? Math.round((counts.doneTasks / counts.totalTasks) * 100) : 100;

  return (
    <div className="space-y-5">
      <PageHeader title={t('familyReports.familyReports')} description="A weekly snapshot of how your household is running — all from live data." />

      <div className="grid gap-5 lg:grid-cols-3">
        <SectionCard title={t('familyReports.completion')} className="lg:col-span-1">
          <div className="flex flex-col items-center gap-2 py-2"><ScoreRing pct={completion} label={t('familyReports.onTrack')} size={150} /></div>
        </SectionCard>
        <SectionCard title={t('familyReports.familyLoad')} className="lg:col-span-1">
          <div className="flex flex-col items-center gap-3 py-2"><ScoreRing pct={stress.score} label="load" size={150} /><LevelBadge level={stress.level} /></div>
        </SectionCard>
        <SectionCard title={t('familyReports.taskCompletion')} className="lg:col-span-1">
          <div className="flex flex-col items-center gap-2 py-2"><ScoreRing pct={taskRate} label="done" size={150} /><p className="text-xs text-muted">{counts.doneTasks} of {counts.totalTasks} tasks</p></div>
        </SectionCard>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <StatTile href="/dashboard/family-coo" label={t('familyReports.openTasks')} value={counts.openTasks} icon={CheckCircle2} accent="bg-emerald-600" sublabel="Operations" />
        <StatTile href="/dashboard/family-cfo" label={t('familyReports.billsDueSoon')} value={counts.overdueBills + counts.billsDueSoon} icon={CreditCard} accent="bg-blue-600" sublabel="Finances" />
        <StatTile href="/dashboard/family-school" label={t('familyReports.schoolDeadlines')} value={counts.homeworkDueSoon} icon={GraduationCap} accent="bg-amber-500" sublabel="School" />
        <StatTile href="/dashboard/family-sports" label={t('familyReports.sports7d')} value={counts.sportsThisWeek} icon={Trophy} accent="bg-teal-600" sublabel="Sports" />
        <StatTile href="/dashboard/family-health" label={t('familyReports.apptsToday')} value={counts.appointmentsToday} icon={HeartPulse} accent="bg-rose-500" sublabel="Health" />
        <StatTile href="/dashboard/family-stress" label={t('familyReports.loadScore')} value={stress.score} icon={Gauge} accent="bg-fuchsia-600" sublabel="Stress" />
      </div>

      <SectionCard title={t('familyReports.highlights')}>
        <ul className="space-y-2 text-sm">
          <li className="flex items-center gap-2"><BarChart3 className="h-4 w-4 text-brand-text" /> {taskRate}{t('familyReports.ofTasksCompletedThisCycle')}</li>
          <li className="flex items-center gap-2"><Gauge className="h-4 w-4 text-violet-400" /> {t('familyReports.familyLoadIs')} <LevelBadge level={stress.level} /> with {stress.factors.length} factor{stress.factors.length === 1 ? '' : 's'} flagged.</li>
          <li className="flex items-center gap-2"><CreditCard className="h-4 w-4 text-blue-400" /> {counts.billsPaid} of {counts.billsTotal} {t('familyReports.trackedBillsArePaid')}</li>
        </ul>
      </SectionCard>
    </div>
  );
}
