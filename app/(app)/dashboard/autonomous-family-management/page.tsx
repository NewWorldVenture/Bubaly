import type { Metadata } from 'next';
import Link from 'next/link';
import {
  Bot, Eye, Sparkles, Zap, ShieldAlert, CheckCircle2,
  CalendarRange, Gauge, ArrowRight, Lock,
} from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isManager } from '@/lib/constants/roles';
import { gatherSignals } from '@/lib/family/signals';
import { PageHeader } from '@/components/app/page-header';
import { SectionCard, MiniEmpty, StatTile, LevelBadge } from '@/components/family/shell';
import { RecommendationActions, AutomationApproval } from '@/components/family/record-actions';
import { fmtRelative } from '@/lib/utils/format';

export const metadata: Metadata = { title: 'Autonomous Management' };
export const dynamic = 'force-dynamic';

const PRIORITY_DOT: Record<string, string> = { high: 'bg-rose-500', medium: 'bg-amber-400', low: 'bg-emerald-500' };

export default async function AutonomousManagementPage() {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();
  const manager = isManager(ctx.active.role);

  const [{ stress, completion, actions, counts }, recs, rules, pendingRuns, doneRuns] = await Promise.all([
    gatherSignals(familyId),
    supabase.from('family_ai_recommendations').select('*').eq('family_id', familyId).eq('status', 'pending').order('created_at', { ascending: false }).limit(8),
    supabase.from('family_automation_rules').select('id, name, is_enabled').eq('family_id', familyId).eq('is_enabled', true),
    supabase.from('family_automation_runs').select('*').eq('family_id', familyId).eq('status', 'pending').order('created_at', { ascending: false }).limit(6),
    supabase.from('family_automation_runs').select('*').eq('family_id', familyId).in('status', ['approved', 'executed']).order('created_at', { ascending: false }).limit(6),
  ]);

  const monitoring = [
    { label: 'Tasks & chores', value: `${counts.openTasks} open` },
    { label: 'Bills', value: `${counts.overdueBills + counts.billsDueSoon} due soon` },
    { label: 'Appointments', value: `${counts.appointmentsToday} today` },
    { label: 'School deadlines', value: `${counts.homeworkDueSoon} this week` },
    { label: 'Sports', value: `${counts.sportsThisWeek} this week` },
    { label: 'Family load', value: stress.level },
  ];

  const risks = stress.factors.filter((f) => f.points >= 8);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Autonomous Family Management"
        description="The AI watches your real data, recommends the next move, and only acts on sensitive things with your approval."
      />

      <div className="rounded-2xl border border-violet-400/25 bg-gradient-to-br from-violet-600/10 to-blue-900/10 p-5">
        <div className="flex items-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-xl bg-gradient-to-br from-violet-500 to-blue-600"><Bot className="h-6 w-6 text-white" /></div>
          <div>
            <p className="font-semibold">Bubaly is monitoring {monitoring.length} areas</p>
            <p className="text-xs text-muted">Last evaluated just now · {rules.data?.length ?? 0} active automations</p>
          </div>
          <div className="ml-auto flex items-center gap-2"><LevelBadge level={stress.level} /><span className="text-sm font-bold tabular-nums">{completion}% on track</span></div>
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <SectionCard title="What AI Is Monitoring" className="lg:col-span-1">
          <ul className="space-y-2.5">
            {monitoring.map((m) => (
              <li key={m.label} className="flex items-center gap-3 text-sm">
                <Eye className="h-4 w-4 shrink-0 text-muted" />
                <span className="flex-1">{m.label}</span>
                <span className="text-xs font-semibold capitalize text-brand-text">{m.value}</span>
              </li>
            ))}
          </ul>
        </SectionCard>

        <SectionCard title="What AI Recommends" description="Stored + derived next-best actions" className="lg:col-span-2">
          {(recs.data && recs.data.length > 0) || actions.length > 0 ? (
            <ul className="space-y-2.5">
              {(recs.data ?? []).map((r) => (
                <li key={r.id} className="flex items-start gap-3 rounded-xl bg-surface/40 p-3">
                  <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-brand-text" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{r.title}</p>
                    {r.body && <p className="text-xs text-muted">{r.body}</p>}
                  </div>
                  <RecommendationActions id={r.id} />
                </li>
              ))}
              {actions.map((a) => (
                <li key={a.id}>
                  <Link href={a.href} className="flex items-start gap-3 rounded-xl bg-surface/40 p-3 transition hover:bg-elevated">
                    <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${PRIORITY_DOT[a.priority]}`} />
                    <span className="min-w-0 flex-1"><span className="block text-sm font-medium">{a.title}</span><span className="block text-xs text-muted">{a.detail}</span></span>
                    <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-muted" />
                  </Link>
                </li>
              ))}
            </ul>
          ) : <MiniEmpty icon={Sparkles} text="Nothing needs attention — you're on top of it." />}
        </SectionCard>
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <StatTile label="Active automations" value={rules.data?.length ?? 0} icon={Zap} accent="bg-violet-600" href="/dashboard/family-automation" sublabel="Manage" />
        <StatTile label="Pending approvals" value={pendingRuns.data?.length ?? 0} icon={Lock} accent="bg-orange-500" />
        <StatTile label="Risk alerts" value={risks.length} icon={ShieldAlert} accent="bg-rose-500" href="/dashboard/family-stress" sublabel="Stress" />
      </div>

      <SectionCard title="Pending Approvals" description="Sensitive actions wait for a parent — never automatic">
        {pendingRuns.data && pendingRuns.data.length > 0 ? (
          <ul className="space-y-2.5">
            {pendingRuns.data.map((run) => (
              <li key={run.id} className="flex items-center gap-3 rounded-xl border border-orange-400/20 bg-orange-500/5 p-3">
                <Lock className="h-4 w-4 shrink-0 text-orange-300" />
                <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{run.summary ?? 'Proposed action'}</p><p className="text-xs text-muted">{fmtRelative(run.created_at)}</p></div>
                {manager ? <AutomationApproval id={run.id} /> : <span className="text-xs text-muted">Awaiting parent</span>}
              </li>
            ))}
          </ul>
        ) : <MiniEmpty icon={CheckCircle2} text="No actions waiting on approval." />}
      </SectionCard>

      <div className="grid gap-5 lg:grid-cols-2">
        <SectionCard title="Weekly Plan" description="AI-optimized focus for the week">
          <ul className="space-y-2.5 text-sm">
            <li className="flex items-center gap-3"><Gauge className="h-4 w-4 text-violet-400" /> Keep family load at or below <LevelBadge level="moderate" /></li>
            {stress.suggestions.map((s, i) => (
              <li key={i} className="flex items-start gap-3"><CalendarRange className="mt-0.5 h-4 w-4 shrink-0 text-blue-400" /> {s}</li>
            ))}
          </ul>
        </SectionCard>

        <SectionCard title="Completed Automations" viewAllHref="/dashboard/family-automation">
          {doneRuns.data && doneRuns.data.length > 0 ? (
            <ul className="divide-y divide-border">
              {doneRuns.data.map((run) => (
                <li key={run.id} className="flex items-center gap-3 py-2.5 text-sm">
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
                  <span className="min-w-0 flex-1 truncate">{run.summary ?? 'Automation run'}</span>
                  <span className="text-xs text-muted">{fmtRelative(run.created_at)}</span>
                </li>
              ))}
            </ul>
          ) : <MiniEmpty icon={Zap} text="No automations have run yet." />}
        </SectionCard>
      </div>
    </div>
  );
}
