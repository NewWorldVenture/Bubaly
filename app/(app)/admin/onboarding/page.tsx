import type { Metadata } from 'next';
import { Timer, CheckCircle2, Sparkles, Target } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import {
  analyzeOnboarding, formatDuration, TTV_GOAL_SEC, type OnboardingRow,
} from '@/lib/onboarding/ttv-audit';
import { cn } from '@/lib/utils/cn';

export const metadata: Metadata = { title: 'Onboarding Audit', robots: { index: false } };
export const dynamic = 'force-dynamic';

export default async function OnboardingAuditPage() {
  const supabase = createServiceClient();

  let rows: OnboardingRow[] = [];
  try {
    const { data } = await supabase
      .from('onboarding_progress')
      .select('created_at, completed_at, status, value_engaged, steps_completed')
      .order('created_at', { ascending: false })
      .limit(5000);
    rows = (data ?? []) as OnboardingRow[];
  } catch { /* table not present */ }

  const a = analyzeOnboarding(rows);
  const maxFunnel = Math.max(1, ...a.stepFunnel.map((s) => s.count));
  const maxStall = Math.max(1, ...a.stalls.map((s) => s.count));

  const stats = [
    { label: 'Median TTV', value: formatDuration(a.medianTtvSec), icon: Timer, tint: 'text-violet-400 bg-violet-500/15' },
    { label: `Reached value ≤ ${TTV_GOAL_SEC}s`, value: a.under90Rate == null ? '—' : `${a.under90Rate}%`, icon: Target, tint: 'text-emerald-400 bg-emerald-500/15' },
    { label: 'Completion rate', value: `${a.completionRate}%`, icon: CheckCircle2, tint: 'text-blue-400 bg-blue-500/15' },
    { label: 'Activated (value)', value: `${a.valueEngagedRate}%`, icon: Sparkles, tint: 'text-amber-400 bg-amber-500/15' },
  ];

  const goalMet = a.under90Rate != null && a.under90Rate >= 50;

  return (
    <div className="space-y-5 p-4 sm:p-6">
      <header>
        <h1 className="text-xl font-black sm:text-2xl">Onboarding Audit</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          The first-run funnel and time-to-value across {a.total.toLocaleString()} onboarding runs.
          The goal is <span className="font-semibold text-fg">first value in under {TTV_GOAL_SEC}s</span> —
          measure it, find where people stall, and trim the friction.
        </p>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {stats.map((s) => (
          <Card key={s.label} className="p-4">
            <div className="flex items-center gap-3">
              <span className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-xl', s.tint)}><s.icon className="h-5 w-5" /></span>
              <div className="min-w-0">
                <p className="text-2xl font-black tabular-nums">{s.value}</p>
                <p className="truncate text-xs text-muted">{s.label}</p>
              </div>
            </div>
          </Card>
        ))}
      </div>

      {a.total > 0 && (
        <Card className={cn('p-4', goalMet ? 'border-emerald-400/30' : 'border-amber-400/30')}>
          <p className="text-sm">
            {goalMet
              ? <><span className="font-bold text-emerald-400">On target.</span> Most completed runs reach value within {TTV_GOAL_SEC}s (p90 {formatDuration(a.p90TtvSec)}).</>
              : <><span className="font-bold text-amber-400">Below target.</span> {a.under90Rate == null ? 'No completed runs yet.' : `Only ${a.under90Rate}% of completed runs reach value within ${TTV_GOAL_SEC}s`} — p90 is {formatDuration(a.p90TtvSec)}. Trim the steps with the biggest drop-off below.</>}
          </p>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Step funnel */}
        <Card className="p-5">
          <h2 className="text-sm font-bold uppercase tracking-wide text-muted">Step completion</h2>
          <div className="mt-4 space-y-2.5">
            {a.stepFunnel.map((s, i) => {
              const prev = i > 0 ? a.stepFunnel[i - 1].count : s.count;
              const drop = prev > 0 ? Math.round((1 - s.count / prev) * 100) : 0;
              return (
                <div key={s.key} className="flex items-center gap-3">
                  <span className="w-24 shrink-0 text-xs font-semibold">{s.label}</span>
                  <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-border">
                    <div className="h-full rounded-full bg-gradient-to-r from-brand to-violet-500" style={{ width: `${(s.count / maxFunnel) * 100}%` }} />
                  </div>
                  <span className="w-24 shrink-0 text-right text-xs tabular-nums text-muted">
                    {s.count.toLocaleString()} · {s.pct}%
                    {i > 0 && drop > 0 && <span className="text-rose-300"> −{drop}%</span>}
                  </span>
                </div>
              );
            })}
          </div>
          <p className="mt-3 text-[10px] text-muted">−% marks the drop-off from the previous step — the biggest ones are where to trim.</p>
        </Card>

        {/* Where runs stall */}
        <Card className="p-5">
          <h2 className="text-sm font-bold uppercase tracking-wide text-muted">Where incomplete runs stall</h2>
          {a.stalls.length === 0 ? (
            <p className="mt-3 text-sm text-muted">No incomplete runs — everyone who starts, finishes. 🎉</p>
          ) : (
            <div className="mt-4 space-y-2.5">
              {a.stalls.map((s) => (
                <div key={s.key} className="flex items-center gap-3">
                  <span className="w-24 shrink-0 text-xs font-semibold">{s.label}</span>
                  <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-border">
                    <div className="h-full rounded-full bg-amber-400/70" style={{ width: `${(s.count / maxStall) * 100}%` }} />
                  </div>
                  <span className="w-12 shrink-0 text-right text-xs tabular-nums text-muted">{s.count.toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
