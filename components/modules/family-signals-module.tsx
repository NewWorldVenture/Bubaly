'use client';

// Family Intelligence — the hard signals (R10). Shows the harder-to-copy patterns
// Bubaly has learned about how THIS family runs (ignored reminders, stress windows,
// chore friction, routines that don't stick), each with its evidence (transparent)
// and Acknowledge / Dismiss controls (editable). A Refresh recomputes from live data.
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  Brain, RefreshCw, AlarmClock, Gauge, Repeat2, ListChecks, Check, X, RotateCcw, ChevronDown, Wallet,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils/cn';
import { refreshSignalsAction, setSignalStatusAction } from '@/app/(app)/dashboard/family-signals/actions';

export interface SignalView {
  id: string; kind: string; title: string; detail: string | null;
  score: number; evidence: Record<string, unknown>; status: string; lastSeenAt: string;
}

const KIND_META: Record<string, { icon: React.ComponentType<{ className?: string }>; label: string; accent: string }> = {
  ignored_reminder: { icon: AlarmClock, label: 'Ignored reminder', accent: 'text-rose-400 bg-rose-500/10' },
  stress_window: { icon: Gauge, label: 'Stress window', accent: 'text-amber-400 bg-amber-500/10' },
  chore_conflict: { icon: Repeat2, label: 'Chore friction', accent: 'text-orange-400 bg-orange-500/10' },
  routine_adherence: { icon: ListChecks, label: 'Routine slipping', accent: 'text-violet-400 bg-violet-500/10' },
  budget_drift: { icon: Wallet, label: 'Over budget', accent: 'text-emerald-400 bg-emerald-500/10' },
};

function evidenceChips(kind: string, ev: Record<string, unknown>): string[] {
  const n = (k: string) => (typeof ev[k] === 'number' ? String(ev[k]) : null);
  switch (kind) {
    case 'ignored_reminder': return [n('count') && `missed ${ev.count}×`].filter(Boolean) as string[];
    case 'stress_window': return [n('events') && `${ev.events} events`, Number(ev.conflicts) > 0 && `${ev.conflicts} clashes`, Number(ev.overdue) > 0 && `${ev.overdue} overdue`].filter(Boolean) as string[];
    case 'chore_conflict': return [Number(ev.rejected) > 0 && `${ev.rejected} rejected`, Number(ev.disputed) > 0 && `${ev.disputed} disputed`, n('members') && `${ev.members} people`].filter(Boolean) as string[];
    case 'routine_adherence': return [n('adherencePct') && `${ev.adherencePct}% adherence`, `${ev.actual}/${ev.expected} done`].filter(Boolean) as string[];
    case 'budget_drift': return [n('spent') && `$${ev.spent} spent`, n('limit') && `$${ev.limit} cap`, ev.recurring === true && '2 periods'].filter(Boolean) as string[];
    default: return [];
  }
}

export function FamilySignalsModule({ active, hidden }: { active: SignalView[]; hidden: SignalView[] }) {
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [pending, startTransition] = useTransition();
  const [showHidden, setShowHidden] = useState(false);

  function refresh() {
    startTransition(async () => {
      const res = await refreshSignalsAction();
      if (!res.ok) { toastError(res.error); return; }
      success(res.data && res.data.signals > 0 ? `Found ${res.data.signals} pattern${res.data.signals === 1 ? '' : 's'}.` : 'No new patterns — you’re running smoothly.');
      router.refresh();
    });
  }
  function setStatus(id: string, status: 'active' | 'acknowledged' | 'dismissed') {
    startTransition(async () => {
      const res = await setSignalStatusAction(id, status);
      if (!res.ok) { toastError(res.error); return; }
      router.refresh();
    });
  }

  return (
    <div className="space-y-6 pb-24">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-brand/15 text-brand-text"><Brain className="h-6 w-6" /></div>
          <div>
            <h1 className="text-xl font-bold">Family Intelligence</h1>
            <p className="mt-0.5 max-w-md text-sm text-muted">Patterns Bubaly has learned about how your family actually runs. Everything here is yours to keep or clear.</p>
          </div>
        </div>
        <Button variant="secondary" onClick={refresh} disabled={pending}>
          <RefreshCw className={cn('h-4 w-4', pending && 'animate-spin')} /> Refresh
        </Button>
      </div>

      {/* At a glance */}
      {active.length > 0 && (
        <div className="grid-stats">
          {(() => {
            const avg = Math.round(active.reduce((s, x) => s + x.score, 0) / active.length);
            const kindCounts = new Map<string, number>();
            for (const s of active) kindCounts.set(s.kind, (kindCounts.get(s.kind) ?? 0) + 1);
            const top = [...kindCounts.entries()].sort((a, b) => b[1] - a[1])[0];
            const topLabel = top ? (KIND_META[top[0]]?.label ?? 'Pattern') : '—';
            return [
              { label: 'Active patterns', value: active.length, icon: '🧠', small: false },
              { label: 'Avg confidence', value: avg, icon: '🎯', small: false },
              { label: 'Most common', value: topLabel, icon: '🔁', small: true },
              { label: 'Handled', value: hidden.length, icon: '✅', small: false },
            ].map(s => (
              <div key={s.label} className="stat-card">
                <span className="text-2xl">{s.icon}</span>
                <div className="min-w-0">
                  <div className={cn('truncate font-bold', s.small ? 'text-sm leading-tight' : 'text-2xl')}>{s.value}</div>
                  <div className="text-[11px] text-muted">{s.label}</div>
                </div>
              </div>
            ));
          })()}
        </div>
      )}

      {active.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-border bg-surface/40 py-12 text-center">
          <div className="grid h-14 w-14 place-items-center rounded-full bg-brand/10"><Brain className="h-7 w-7 text-brand-text" /></div>
          <div>
            <p className="font-semibold">No patterns to flag yet</p>
            <p className="mx-auto mt-1 max-w-xs text-sm text-muted">As your family uses Bubaly, it learns what keeps slipping and when you’re stretched. Refresh to check now.</p>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {active.map((s) => {
            const meta = KIND_META[s.kind] ?? { icon: Brain, label: 'Pattern', accent: 'text-brand-text bg-brand/10' };
            const Icon = meta.icon;
            return (
              <div key={s.id} className="rounded-2xl border border-border bg-surface/40 p-4">
                <div className="flex items-start gap-3">
                  <div className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-xl', meta.accent)}><Icon className="h-5 w-5" /></div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-semibold uppercase tracking-wide text-muted">{meta.label}</span>
                      <span className="rounded-full bg-elevated px-1.5 py-0.5 text-[10px] font-bold text-fg/70">{s.score}</span>
                    </div>
                    <p className="mt-0.5 text-sm font-semibold">{s.title}</p>
                    {s.detail && <p className="mt-0.5 text-xs text-muted">{s.detail}</p>}
                    {evidenceChips(s.kind, s.evidence).length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {evidenceChips(s.kind, s.evidence).map((c) => (
                          <span key={c} className="rounded-full border border-border/70 bg-bg/40 px-2 py-0.5 text-[10px] font-medium text-muted">{c}</span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <div className="mt-3 flex items-center justify-end gap-2 border-t border-border/40 pt-3">
                  <button type="button" onClick={() => setStatus(s.id, 'acknowledged')} disabled={pending}
                    className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted transition hover:bg-elevated hover:text-fg disabled:opacity-50">
                    <Check className="h-3.5 w-3.5" /> Got it
                  </button>
                  <button type="button" onClick={() => setStatus(s.id, 'dismissed')} disabled={pending}
                    className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted transition hover:bg-elevated hover:text-fg disabled:opacity-50">
                    <X className="h-3.5 w-3.5" /> Not useful
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {hidden.length > 0 && (
        <div>
          <button type="button" onClick={() => setShowHidden((v) => !v)}
            className="flex items-center gap-1.5 text-xs font-semibold text-muted transition hover:text-fg">
            <ChevronDown className={cn('h-3.5 w-3.5 transition', showHidden && 'rotate-180')} />
            {hidden.length} acknowledged / dismissed
          </button>
          {showHidden && (
            <div className="mt-3 space-y-2">
              {hidden.map((s) => (
                <div key={s.id} className="flex items-center gap-3 rounded-xl border border-border/60 bg-surface/20 px-4 py-2.5">
                  <span className="min-w-0 flex-1 truncate text-sm text-muted">{s.title}</span>
                  <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted">{s.status}</span>
                  <button type="button" onClick={() => setStatus(s.id, 'active')} disabled={pending}
                    className="inline-flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-brand-text transition hover:bg-elevated disabled:opacity-50">
                    <RotateCcw className="h-3.5 w-3.5" /> Restore
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
