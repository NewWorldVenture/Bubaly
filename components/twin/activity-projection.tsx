'use client';

// R8 — the full Household Twin activity projection. "If Emma joins travel soccer,
// what has to move?" Runs the pure multi-dimensional projection (schedule ·
// travel · cost · family time · homework · meals · vacation) against the real
// household and shows the ripple BEFORE committing. Save a scenario to keep it.
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  Sparkles, CalendarClock, Car, DollarSign, Clock, GraduationCap, UtensilsCrossed, Plane,
  Loader2, Save, Trash2, CircleCheck, CircleAlert, CircleX,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils/cn';
import {
  projectActivityAction, saveSimulationAction, deleteSimulationAction,
  type ActivityProjectionInput,
} from '@/app/(app)/dashboard/family-digital-twin/actions';
import type { ProjectionResult, ProjectionDimension } from '@/lib/twin/simulate';

const DIM_ICON: Record<ProjectionDimension['key'], React.ComponentType<{ className?: string }>> = {
  schedule: CalendarClock, travel: Car, cost: DollarSign, family_time: Clock,
  homework: GraduationCap, meals: UtensilsCrossed, vacation: Plane,
};
const SEV = {
  ok: { dot: 'text-emerald-400', Icon: CircleCheck },
  caution: { dot: 'text-amber-400', Icon: CircleAlert },
  blocker: { dot: 'text-rose-400', Icon: CircleX },
} as const;
const VERDICT = {
  clear: { label: 'Fits cleanly', cls: 'border-emerald-500/30 bg-emerald-500/5 text-emerald-300' },
  tight: { label: 'Doable — plan around it', cls: 'border-amber-500/30 bg-amber-500/5 text-amber-300' },
  conflict: { label: 'Conflicts to resolve', cls: 'border-rose-500/30 bg-rose-500/5 text-rose-300' },
} as const;

const inputCls = 'h-10 w-full rounded-xl border border-border bg-bg px-3 text-sm focus-ring';

export interface SavedSim {
  id: string; activityName: string; verdict: string; weeklyHours: number; createdAt: string;
}

export function ActivityProjection({
  members, budgetCategories, saved,
}: {
  members: { id: string; display_name: string }[];
  budgetCategories: string[];
  saved: SavedSim[];
}) {
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<ProjectionResult | null>(null);

  const [memberId, setMemberId] = useState(members[0]?.id ?? '');
  const [activityName, setActivityName] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [durationMin, setDurationMin] = useState(90);
  const [sessionsPerWeek, setSessionsPerWeek] = useState(2);
  const [weeks, setWeeks] = useState(12);
  const [travelMinEach, setTravelMinEach] = useState(20);
  const [costDollars, setCostDollars] = useState(0);
  const [costCategory, setCostCategory] = useState('');

  function currentInput(): ActivityProjectionInput {
    return {
      memberId, memberName: members.find((m) => m.id === memberId)?.display_name ?? 'They',
      activityName, startsAt: startsAt ? new Date(startsAt).toISOString() : '',
      durationMin, sessionsPerWeek, weeks,
      travelMinEach: travelMinEach || undefined,
      costDollars: costDollars || undefined, costCategory: costCategory || undefined,
    };
  }

  function project() {
    startTransition(async () => {
      const res = await projectActivityAction(currentInput());
      if (!res.ok) { toastError(res.error); return; }
      setResult(res.data);
    });
  }
  function save() {
    if (!result) return;
    startTransition(async () => {
      const res = await saveSimulationAction(currentInput(), result);
      if (!res.ok) { toastError(res.error); return; }
      success('Scenario saved.'); router.refresh();
    });
  }
  function remove(id: string) {
    startTransition(async () => {
      const res = await deleteSimulationAction(id);
      if (!res.ok) { toastError(res.error); return; }
      router.refresh();
    });
  }

  return (
    <div className="rounded-2xl border border-border bg-surface/40 p-5">
      <div className="mb-4 flex items-center gap-2">
        <div className="grid h-9 w-9 place-items-center rounded-xl bg-brand/15 text-brand"><Sparkles className="h-5 w-5" /></div>
        <div>
          <h2 className="text-sm font-bold">Activity projection</h2>
          <p className="text-xs text-muted">See the full ripple before you say yes — schedule, driving, cost, family time.</p>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <select value={memberId} onChange={(e) => setMemberId(e.target.value)} className={inputCls} aria-label="Member">
          {members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
        </select>
        <input value={activityName} onChange={(e) => setActivityName(e.target.value)} placeholder="Travel soccer" className={inputCls} aria-label="Activity" />
        <label className="text-xs text-muted">First session
          <input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} className={inputCls} aria-label="First session" />
        </label>
        <label className="text-xs text-muted">Minutes / session
          <input type="number" min={15} step={15} value={durationMin} onChange={(e) => setDurationMin(+e.target.value)} className={inputCls} />
        </label>
        <label className="text-xs text-muted">Sessions / week
          <input type="number" min={1} max={7} value={sessionsPerWeek} onChange={(e) => setSessionsPerWeek(+e.target.value)} className={inputCls} />
        </label>
        <label className="text-xs text-muted">Weeks
          <input type="number" min={1} max={52} value={weeks} onChange={(e) => setWeeks(+e.target.value)} className={inputCls} />
        </label>
        <label className="text-xs text-muted">Travel each way (min)
          <input type="number" min={0} step={5} value={travelMinEach} onChange={(e) => setTravelMinEach(+e.target.value)} className={inputCls} />
        </label>
        <label className="text-xs text-muted">Cost ($)
          <input type="number" min={0} value={costDollars} onChange={(e) => setCostDollars(+e.target.value)} className={inputCls} />
        </label>
        {budgetCategories.length > 0 && (
          <select value={costCategory} onChange={(e) => setCostCategory(e.target.value)} className={inputCls} aria-label="Budget category">
            <option value="">No budget check</option>
            {budgetCategories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        )}
      </div>

      <Button className="mt-3 w-full" onClick={project} disabled={pending || !activityName.trim() || !startsAt}>
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />} Project the ripple
      </Button>

      {result && (
        <div className="mt-4 space-y-3">
          <div className={cn('flex items-center justify-between rounded-xl border px-4 py-2.5', VERDICT[result.verdict].cls)}>
            <span className="text-sm font-semibold">{result.headline}</span>
            <span className="shrink-0 text-xs font-bold">≈ {result.weeklyHours}h/wk</span>
          </div>
          <div className="space-y-1.5">
            {result.dimensions.map((d) => {
              const DimIcon = DIM_ICON[d.key];
              const sev = SEV[d.severity];
              return (
                <div key={d.key} className="flex items-start gap-3 rounded-xl border border-border/60 bg-bg/30 px-3 py-2">
                  <DimIcon className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold">{d.label}</p>
                    <p className="text-xs text-muted">{d.headline}{d.detail ? ` · ${d.detail}` : ''}</p>
                  </div>
                  <sev.Icon className={cn('mt-0.5 h-4 w-4 shrink-0', sev.dot)} />
                </div>
              );
            })}
          </div>
          <Button variant="secondary" className="w-full" onClick={save} disabled={pending}>
            <Save className="h-4 w-4" /> Save this scenario
          </Button>
        </div>
      )}

      {saved.length > 0 && (
        <div className="mt-5 border-t border-border/40 pt-4">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Saved scenarios</p>
          <ul className="space-y-1.5">
            {saved.map((s) => (
              <li key={s.id} className="flex items-center gap-2 rounded-xl border border-border/60 bg-bg/30 px-3 py-2 text-sm">
                <span className={cn('h-2 w-2 shrink-0 rounded-full',
                  s.verdict === 'clear' ? 'bg-emerald-400' : s.verdict === 'tight' ? 'bg-amber-400' : 'bg-rose-400')} />
                <span className="min-w-0 flex-1 truncate">{s.activityName}</span>
                <span className="shrink-0 text-xs text-muted">{s.weeklyHours}h/wk</span>
                <button type="button" onClick={() => remove(s.id)} disabled={pending} aria-label="Delete scenario"
                  className="shrink-0 rounded-lg p-1 text-muted transition hover:bg-elevated hover:text-rose-400 disabled:opacity-50">
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
