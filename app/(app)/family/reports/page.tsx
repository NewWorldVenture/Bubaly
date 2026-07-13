import type { Metadata } from 'next';
import { BarChart3, CheckCircle2, CreditCard, GraduationCap, Trophy, HeartPulse, Gauge } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { gatherSignals } from '@/lib/family/signals';
import { PageHeader } from '@/components/app/page-header';
import { StatTile, SectionCard, ScoreRing, LevelBadge } from '@/components/family/shell';

export const metadata: Metadata = { title: 'Family Reports' };
export const dynamic = 'force-dynamic';

export default async function FamilyReportsPage() {
  const ctx = await requireUserContext();
  const { stress, completion, counts } = await gatherSignals(ctx.active.familyId);
  const taskRate = counts.totalTasks > 0 ? Math.round((counts.doneTasks / counts.totalTasks) * 100) : 100;

  return (
    <div className="space-y-5">
      <PageHeader title="Family Reports" description="A weekly snapshot of how your household is running — all from live data." />

      <div className="grid gap-5 lg:grid-cols-3">
        <SectionCard title="Completion" className="lg:col-span-1">
          <div className="flex flex-col items-center gap-2 py-2"><ScoreRing pct={completion} label="on track" size={150} /></div>
        </SectionCard>
        <SectionCard title="Family Load" className="lg:col-span-1">
          <div className="flex flex-col items-center gap-3 py-2"><ScoreRing pct={stress.score} label="load" size={150} /><LevelBadge level={stress.level} /></div>
        </SectionCard>
        <SectionCard title="Task Completion" className="lg:col-span-1">
          <div className="flex flex-col items-center gap-2 py-2"><ScoreRing pct={taskRate} label="done" size={150} /><p className="text-xs text-muted">{counts.doneTasks} of {counts.totalTasks} tasks</p></div>
        </SectionCard>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <StatTile href="/dashboard/family-coo" label="Open tasks" value={counts.openTasks} icon={CheckCircle2} accent="bg-emerald-600" sublabel="Operations" />
        <StatTile href="/dashboard/family-cfo" label="Bills due soon" value={counts.overdueBills + counts.billsDueSoon} icon={CreditCard} accent="bg-blue-600" sublabel="Finances" />
        <StatTile href="/dashboard/family-school" label="School deadlines" value={counts.homeworkDueSoon} icon={GraduationCap} accent="bg-amber-500" sublabel="School" />
        <StatTile href="/dashboard/family-sports" label="Sports (7d)" value={counts.sportsThisWeek} icon={Trophy} accent="bg-teal-600" sublabel="Sports" />
        <StatTile href="/dashboard/family-health" label="Appts today" value={counts.appointmentsToday} icon={HeartPulse} accent="bg-rose-500" sublabel="Health" />
        <StatTile href="/dashboard/family-stress" label="Load score" value={stress.score} icon={Gauge} accent="bg-fuchsia-600" sublabel="Stress" />
      </div>

      <SectionCard title="Highlights">
        <ul className="space-y-2 text-sm">
          <li className="flex items-center gap-2"><BarChart3 className="h-4 w-4 text-brand-text" /> {taskRate}% of tasks completed this cycle.</li>
          <li className="flex items-center gap-2"><Gauge className="h-4 w-4 text-violet-400" /> Family load is <LevelBadge level={stress.level} /> with {stress.factors.length} factor{stress.factors.length === 1 ? '' : 's'} flagged.</li>
          <li className="flex items-center gap-2"><CreditCard className="h-4 w-4 text-blue-400" /> {counts.billsPaid} of {counts.billsTotal} tracked bills are paid.</li>
        </ul>
      </SectionCard>
    </div>
  );
}
