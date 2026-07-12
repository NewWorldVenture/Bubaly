'use client';

import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { Scale, TrendingUp, ArrowRightLeft, Sparkles, Loader2, CheckCircle2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { PageHeader } from '@/components/app/page-header';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils/cn';
import {
  computeWorkload, shareTrend, isoWeekStart,
  type WorkloadChoreAssignment, type RebalanceSuggestion,
} from '@/lib/workload/balance';
import { moveAssignmentAction, saveWorkloadSnapshotAction } from '@/app/(app)/dashboard/workload/actions';
import type { Tables } from '@/lib/database.types';

type Member = { id: string; display_name: string; role: string; color: string | null; user_id: string | null };

const BAR_COLORS = ['bg-brand', 'bg-blue-400', 'bg-violet-400', 'bg-emerald-400', 'bg-amber-400', 'bg-rose-400'];

export function WorkloadModule({
  members, assignments, chores, todos, events, snapshots,
}: {
  familyId: string;
  members: Member[];
  assignments: { id: string; chore_id: string; member_id: string; status: string; created_at: string }[];
  chores: { id: string; title: string; est_minutes: number | null; points: number }[];
  todos: { assigned_to_id: string | null; is_done: boolean; created_at: string }[];
  events: { created_by: string | null; starts_at: string }[];
  snapshots: Tables<'workload_snapshots'>[];
}) {
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [pending, startTransition] = useTransition();
  const [applying, setApplying] = useState<string | null>(null);
  const [applied, setApplied] = useState<Set<string>>(new Set());

  const report = useMemo(() => {
    const choreById = new Map(chores.map(c => [c.id, c]));
    const engineAssignments: WorkloadChoreAssignment[] = assignments.map(a => {
      const c = choreById.get(a.chore_id);
      return {
        id: a.id, choreId: a.chore_id, memberId: a.member_id, status: a.status,
        choreTitle: c?.title ?? 'Chore', estMinutes: c?.est_minutes ?? null, points: c?.points ?? 10,
      };
    });
    // calendar_events.created_by is an auth user id — map to member ids.
    const memberByUser = new Map(members.filter(m => m.user_id).map(m => [m.user_id as string, m.id]));
    const engineEvents = events.map(e => ({ createdBy: e.created_by ? memberByUser.get(e.created_by) ?? null : null }));
    return computeWorkload(
      members.map(m => ({ id: m.id, name: m.display_name, role: m.role })),
      engineAssignments,
      todos.map(t => ({ assignedToId: t.assigned_to_id, isDone: t.is_done })),
      engineEvents,
    );
  }, [members, assignments, chores, todos, events]);

  // Persist this week's computed loads once per view (idempotent upsert).
  const saved = useRef(false);
  useEffect(() => {
    if (saved.current || report.loads.every(l => l.sharePct === 0)) return;
    saved.current = true;
    const weekStart = isoWeekStart(new Date());
    void saveWorkloadSnapshotAction(report.loads.map(l => ({
      memberId: l.memberId, weekStart, choreMinutes: l.choreMinutes, choreCount: l.choreCount,
      taskCount: l.taskCount, eventCount: l.eventCount, loadScore: l.loadScore, sharePct: l.sharePct,
    })));
  }, [report]);

  const trend = useMemo(() => shareTrend(
    snapshots.map(s => ({ memberId: s.member_id, weekStart: s.week_start, sharePct: Number(s.share_pct) })),
  ), [snapshots]);

  const maxShare = Math.max(...report.loads.map(l => l.sharePct), 1);
  const fairnessTone = report.fairness >= 80 ? 'text-emerald-400' : report.fairness >= 55 ? 'text-amber-400' : 'text-rose-400';

  function applySuggestion(s: RebalanceSuggestion) {
    setApplying(s.assignmentId);
    startTransition(async () => {
      const res = await moveAssignmentAction(s.assignmentId, s.toMemberId);
      setApplying(null);
      if (!res.ok) { toastError(res.error); return; }
      setApplied(prev => new Set(prev).add(s.assignmentId));
      success(`“${s.choreTitle}” moved to ${s.toName}.`);
      router.refresh();
    });
  }

  return (
    <div className="module-page">
      <PageHeader
        title="Workload Balance"
        description="Who's carrying the household — measured, made visible, and one tap to fix."
      />

      {/* AI headline */}
      <div className="mb-4 flex items-start gap-3 rounded-2xl border border-brand/20 bg-gradient-to-br from-brand/10 to-transparent p-4">
        <div className="grid h-10 w-10 flex-shrink-0 place-items-center rounded-xl bg-brand/15">
          <Sparkles className="h-5 w-5 text-brand" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-bold">{report.headline}</p>
          <p className="mt-0.5 text-xs text-muted">
            Load counts chores by estimated minutes, plus tasks and the invisible work of organizing events.
          </p>
        </div>
      </div>

      {/* Stats */}
      <div className="grid-stats">
        <div className="stat-card">
          <span className="text-2xl">⚖️</span>
          <div>
            <div className={cn('text-2xl font-bold', fairnessTone)}>{report.fairness}</div>
            <div className="text-[11px] text-muted">Fairness score</div>
          </div>
        </div>
        <div className="stat-card">
          <span className="text-2xl">🏋️</span>
          <div>
            <div className="text-2xl font-bold">{report.loads[0]?.sharePct ?? 0}%</div>
            <div className="text-[11px] text-muted">{report.loads[0] ? `${report.loads[0].name}'s share` : 'Heaviest share'}</div>
          </div>
        </div>
        <div className="stat-card">
          <span className="text-2xl">⏱️</span>
          <div>
            <div className="text-2xl font-bold">
              {Math.round(report.loads.reduce((s, l) => s + l.choreMinutes, 0) / 60 * 10) / 10}h
            </div>
            <div className="text-[11px] text-muted">Chore hours this week</div>
          </div>
        </div>
        <div className="stat-card">
          <span className="text-2xl">🔁</span>
          <div>
            <div className="text-2xl font-bold">{report.suggestions.length}</div>
            <div className="text-[11px] text-muted">Rebalance moves ready</div>
          </div>
        </div>
      </div>

      {/* Per-member load bars */}
      <section className="mt-5 rounded-2xl border border-border bg-surface/30 p-4">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-bold"><Scale className="h-4 w-4 text-brand" /> This week&apos;s split</h2>
        <div className="space-y-3">
          {report.loads.map((l, i) => (
            <div key={l.memberId}>
              <div className="mb-1 flex items-baseline justify-between gap-2">
                <span className="truncate text-sm font-semibold">
                  {l.name}
                  {l.overloaded && <span className="ml-2 rounded-full bg-rose-500/15 px-2 py-0.5 text-[10px] font-bold text-rose-400">carrying too much</span>}
                </span>
                <span className="flex-shrink-0 text-xs text-muted">
                  {l.sharePct}% · {Math.round(l.choreMinutes / 6) / 10}h chores · {l.taskCount} tasks · {l.eventCount} organized
                </span>
              </div>
              <div className="h-2.5 overflow-hidden rounded-full bg-elevated">
                <div
                  className={cn('h-full rounded-full transition-all', BAR_COLORS[i % BAR_COLORS.length])}
                  style={{ width: `${Math.max(2, (l.sharePct / maxShare) * 100)}%` }}
                />
              </div>
            </div>
          ))}
          {report.loads.length === 0 && (
            <p className="py-6 text-center text-sm text-muted">Add family members to see the balance.</p>
          )}
        </div>
      </section>

      {/* Rebalance suggestions */}
      {report.suggestions.length > 0 && (
        <section className="mt-4 rounded-2xl border border-border bg-surface/30 p-4">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-bold">
            <ArrowRightLeft className="h-4 w-4 text-brand" /> One-tap rebalance
          </h2>
          <div className="space-y-2">
            {report.suggestions.map(s => {
              const done = applied.has(s.assignmentId);
              return (
                <div key={s.assignmentId} className="flex items-center gap-3 rounded-xl border border-border bg-elevated/50 p-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold">
                      Move “{s.choreTitle}” → {s.toName}
                    </p>
                    <p className="mt-0.5 text-xs text-muted">{s.reason}</p>
                  </div>
                  <button
                    onClick={() => applySuggestion(s)}
                    disabled={pending || done}
                    className={cn('flex-shrink-0 rounded-lg px-3 py-2 text-xs font-bold transition',
                      done ? 'bg-emerald-500/15 text-emerald-400'
                        : 'bg-brand text-brand-fg hover:opacity-90 disabled:opacity-50')}
                  >
                    {done ? <span className="flex items-center gap-1"><CheckCircle2 className="h-3.5 w-3.5" /> Moved</span>
                      : applying === s.assignmentId ? <Loader2 className="h-4 w-4 animate-spin" />
                      : 'Move it'}
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Week-over-week trend */}
      <section className="mt-4 rounded-2xl border border-border bg-surface/30 p-4">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-bold"><TrendingUp className="h-4 w-4 text-brand" /> Share of load, week over week</h2>
        {trend.size === 0 ? (
          <p className="py-4 text-center text-sm text-muted">
            History builds automatically each week you visit — check back after a few weeks.
          </p>
        ) : (
          <div className="space-y-4">
            {members.map((m, i) => {
              const rows = trend.get(m.id);
              if (!rows?.length) return null;
              const recent = rows.slice(-12);
              return (
                <div key={m.id}>
                  <div className="mb-1 flex items-baseline justify-between">
                    <span className="text-xs font-semibold">{m.display_name}</span>
                    <span className="text-[11px] text-muted">now {recent[recent.length - 1].sharePct}%</span>
                  </div>
                  <div className="flex h-10 items-end gap-1">
                    {recent.map(r => (
                      <div key={r.weekStart} title={`${r.weekStart}: ${r.sharePct}%`}
                        className={cn('flex-1 rounded-t', BAR_COLORS[i % BAR_COLORS.length], 'opacity-80')}
                        style={{ height: `${Math.max(6, r.sharePct)}%` }}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
