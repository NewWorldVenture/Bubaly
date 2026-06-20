import type { Metadata } from 'next';
import Link from 'next/link';
import {
  Calendar, CheckCircle2, ListChecks, Stethoscope, GraduationCap,
  Trophy, CreditCard, Activity, Sparkles, ArrowRight, ShieldAlert,
} from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { gatherSignals } from '@/lib/family/signals';
import { PageHeader } from '@/components/app/page-header';
import { StatTile, SectionCard, ScoreRing, LevelBadge, MiniEmpty } from '@/components/family/shell';

export const metadata: Metadata = { title: 'Family Operations' };
export const dynamic = 'force-dynamic';

const PRIORITY_DOT: Record<string, string> = {
  high: 'bg-rose-500', medium: 'bg-amber-400', low: 'bg-emerald-500',
};

export default async function FamilyOperationsPage() {
  const ctx = await requireUserContext();
  const { stress, completion, actions, counts } = await gatherSignals(ctx.active.familyId);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Family Operations"
        description="One command center for everything your household is running today."
      />

      {/* Top row: completion + stress + next actions */}
      <div className="grid gap-5 lg:grid-cols-3">
        <SectionCard title="Family Completion" description="Weighted across tasks, bills, school & routines">
          <div className="flex items-center gap-6">
            <ScoreRing pct={completion} label="On track" />
            <ul className="space-y-2 text-sm">
              <li className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4 text-emerald-400" /> {counts.doneTasks}/{counts.totalTasks} tasks done</li>
              <li className="flex items-center gap-2"><CreditCard className="h-4 w-4 text-blue-400" /> {counts.billsPaid}/{counts.billsTotal} bills paid</li>
              <li className="flex items-center gap-2"><Activity className="h-4 w-4 text-violet-400" /> {counts.routinesTotal} active routines</li>
            </ul>
          </div>
        </SectionCard>

        <SectionCard title="Family Load" description="Predicted stress for the week" viewAllHref="/dashboard/family-stress">
          <div className="flex items-center gap-6">
            <ScoreRing pct={stress.score} label={stress.level} />
            <div className="space-y-2">
              <LevelBadge level={stress.level} />
              <ul className="space-y-1 text-xs text-muted">
                {stress.factors.slice(0, 3).map((f) => (
                  <li key={f.label}>• {f.detail}</li>
                ))}
                {stress.factors.length === 0 && <li>Balanced week — nothing flagged.</li>}
              </ul>
            </div>
          </div>
        </SectionCard>

        <SectionCard title="AI Next-Best Actions" description="Derived from your real data" viewAllHref="/dashboard/autonomous-family-management">
          {actions.length > 0 ? (
            <ul className="space-y-2.5">
              {actions.slice(0, 5).map((a) => (
                <li key={a.id}>
                  <Link href={a.href} className="flex items-start gap-3 rounded-xl bg-surface/40 p-3 transition hover:bg-elevated">
                    <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${PRIORITY_DOT[a.priority]}`} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{a.title}</span>
                      <span className="block text-xs text-muted">{a.detail}</span>
                    </span>
                    <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-muted" />
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <MiniEmpty icon={Sparkles} text="All clear — nothing needs attention." />
          )}
        </SectionCard>
      </div>

      {/* Stat grid drilling into the real module pages */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile href="/dashboard/calendar" label="Events today" value={counts.eventsToday} icon={Calendar} accent="bg-violet-600" sublabel="Calendar" />
        <StatTile href="/dashboard/family-coo" label="Tasks open" value={counts.openTasks} icon={ListChecks} accent="bg-emerald-600" sublabel="Operations" />
        <StatTile href="/dashboard/family-cfo" label="Bills due soon" value={counts.overdueBills + counts.billsDueSoon} icon={CreditCard} accent="bg-blue-600" sublabel="Finances" />
        <StatTile href="/dashboard/family-health" label="Appts today" value={counts.appointmentsToday} icon={Stethoscope} accent="bg-rose-500" sublabel="Health" />
        <StatTile href="/dashboard/family-school" label="School deadlines" value={counts.homeworkDueSoon} icon={GraduationCap} accent="bg-amber-500" sublabel="School" />
        <StatTile href="/dashboard/family-sports" label="Sports this week" value={counts.sportsThisWeek} icon={Trophy} accent="bg-teal-600" sublabel="Sports" />
        <StatTile href="/dashboard/family-coo" label="Due today" value={counts.dueTodayTasks} icon={CheckCircle2} accent="bg-orange-500" sublabel="Operations" />
        <StatTile href="/dashboard/family-stress" label="Load score" value={`${stress.score}`} icon={ShieldAlert} accent="bg-fuchsia-600" sublabel="Stress" />
      </div>
    </div>
  );
}
