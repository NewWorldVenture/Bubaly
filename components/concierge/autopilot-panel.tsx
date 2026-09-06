'use client';

// The Autopilot panel — the family's control surface for the autonomous
// execution loop. Shows the trust dial (Auto-pilot / Ask first / Off), the
// queue of runs waiting for approval (one-tap Approve / Dismiss), and the feed
// of what Bubaly executed on its own. Reads the same trust_policies /
// family_automation_runs rows the server loop writes; all writes go through
// the manager-gated server actions.
import { useCallback, useEffect, useState, useTransition } from 'react';
import { Bot, Check, ChevronDown, Loader2, ShieldQuestion, Sparkles, X, Zap } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { createClient } from '@/lib/supabase/client';
import { isManager } from '@/lib/constants/roles';
import {
  AUTOPILOT_POLICY_NAME, autopilotStats, dialLevel, type AutopilotLevel,
} from '@/lib/autonomy/loop';
import {
  dismissQueuedRunAction, executeQueuedRunAction, setConciergeAutopilotAction,
} from '@/app/(app)/dashboard/concierge/actions';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils/cn';
import { useTranslations } from '@/components/i18n/locale-provider';

type Run = {
  id: string; status: string; trigger_type: string | null; summary: string | null;
  created_at: string; metadata: unknown;
};

const LEVELS: { key: AutopilotLevel; label: string; hint: string; icon: typeof Zap }[] = [
  { key: 'auto', label: 'Auto-pilot', hint: 'Accepted plans execute on their own', icon: Zap },
  { key: 'ask', label: 'Ask first', hint: 'Bubaly queues it for one-tap approval', icon: ShieldQuestion },
  { key: 'off', label: 'Off', hint: 'Manual buttons only', icon: X },
];

export function AutopilotPanel({ className }: { className?: string }) {
  const t = useTranslations();
  const { familyId, role } = useApp();
  const { success, error: toastError } = useToast();
  const manager = isManager(role);
  const [level, setLevel] = useState<AutopilotLevel>('ask');
  const [runs, setRuns] = useState<Run[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const supabase = createClient();
    // Both reads are best-effort: a family that predates 0093/0022 in prod just
    // sees the default dial and an empty feed.
    try {
      const [{ data: policy }, { data: runRows }] = await Promise.all([
        supabase.from('trust_policies').select('effect')
          .eq('family_id', familyId).eq('name', AUTOPILOT_POLICY_NAME).maybeSingle(),
        supabase.from('family_automation_runs')
          .select('id, status, trigger_type, summary, created_at, metadata')
          .eq('family_id', familyId).eq('trigger_type', 'plan_accepted')
          .order('created_at', { ascending: false }).limit(30),
      ]);
      setLevel(dialLevel(policy?.effect));
      setRuns((runRows ?? []) as Run[]);
    } catch { /* degrade silently */ }
    setLoaded(true);
  }, [familyId]);

  useEffect(() => { void load(); }, [load]);

  const stats = autopilotStats(runs);
  const queued = runs.filter((r) => r.status === 'pending');
  const executed = runs.filter((r) => r.status === 'executed').slice(0, 5);

  const changeLevel = (next: AutopilotLevel) => {
    if (!manager || next === level) return;
    const prev = level;
    setLevel(next);
    startTransition(async () => {
      const res = await setConciergeAutopilotAction(next);
      if (!res.ok) { setLevel(prev); toastError(res.error); }
      else success(next === 'auto' ? 'Auto-pilot on — accepted plans execute themselves' : next === 'ask' ? 'Bubaly will ask before executing' : 'Autopilot off');
    });
  };

  const approve = (runId: string) => {
    setBusyId(runId);
    startTransition(async () => {
      const res = await executeQueuedRunAction(runId);
      if (!res.ok) toastError(res.error);
      else success(res.summary ?? 'Executed');
      setBusyId(null);
      void load();
    });
  };

  const dismiss = (runId: string) => {
    setBusyId(runId);
    startTransition(async () => {
      const res = await dismissQueuedRunAction(runId);
      if (!res.ok) toastError(res.error);
      setBusyId(null);
      void load();
    });
  };

  if (!loaded) return null;

  return (
    <div className={cn('rounded-2xl border border-violet-400/25 bg-gradient-to-br from-violet-600/10 to-transparent p-4', className)}>
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-3 text-left">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-violet-500 to-blue-600">
          <Bot className="h-5 w-5 text-white" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2 text-sm font-bold">
            {t('autopilot.autopilot')}
            <span className={cn(
              'rounded-full px-2 py-0.5 text-[10px] font-black uppercase tracking-wide',
              level === 'auto' ? 'bg-emerald-500/15 text-emerald-300'
                : level === 'ask' ? 'bg-amber-500/15 text-amber-300'
                : 'bg-white/[0.08] text-muted',
            )}>
              {LEVELS.find((l) => l.key === level)?.label}
            </span>
            {queued.length > 0 && (
              <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-bold text-amber-300">
                {queued.length} waiting
              </span>
            )}
          </span>
          <span className="block text-xs text-muted">
            {stats.executedThisWeek > 0
              ? `${stats.executedThisWeek} plan${stats.executedThisWeek === 1 ? '' : 's'} executed for you this week`
              : 'Accepted plans can land on the calendar, reminders and tasks by themselves.'}
          </span>
        </span>
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="mt-4 space-y-4">
          {/* The dial */}
          <div>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted">
              {t('autopilot.whenYouAcceptAPlan')}{manager ? '' : ' (parents/guardians can change this)'}
            </p>
            <div className="grid grid-cols-3 gap-1.5">
              {LEVELS.map((l) => (
                <button
                  key={l.key}
                  type="button"
                  onClick={() => changeLevel(l.key)}
                  disabled={!manager || pending}
                  title={l.hint}
                  className={cn(
                    'flex flex-col items-center gap-1 rounded-xl border px-2 py-2 text-[11px] font-bold transition disabled:cursor-not-allowed',
                    level === l.key
                      ? 'border-violet-400/60 bg-violet-500/15 text-violet-200'
                      : 'border-border text-muted hover:bg-elevated disabled:opacity-50',
                  )}
                >
                  <l.icon className="h-4 w-4" /> {l.label}
                </button>
              ))}
            </div>
          </div>

          {/* Waiting for approval */}
          {queued.length > 0 && (
            <div>
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300">{t('autopilot.waitingForYourOk')}</p>
              <div className="space-y-1.5">
                {queued.map((r) => (
                  <div key={r.id} className="flex items-center gap-2 rounded-xl border border-amber-400/25 bg-amber-500/[0.06] px-3 py-2">
                    <span className="min-w-0 flex-1 text-xs">{(r.summary ?? 'Queued plan').replace(/^Waiting for approval: /, '')}</span>
                    {manager && (
                      <>
                        <button
                          type="button" onClick={() => approve(r.id)} disabled={pending}
                          className="inline-flex h-7 items-center gap-1 rounded-lg bg-emerald-500/15 px-2.5 text-[11px] font-bold text-emerald-300 transition hover:bg-emerald-500/25 disabled:opacity-50"
                        >
                          {busyId === r.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />} Do it
                        </button>
                        <button
                          type="button" onClick={() => dismiss(r.id)} disabled={pending}
                          aria-label="Dismiss" title="Dismiss"
                          className="grid h-7 w-7 place-items-center rounded-lg text-muted transition hover:text-rose-400 disabled:opacity-50"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Done for you */}
          {executed.length > 0 && (
            <div>
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted">{t('autopilot.doneForYou')}</p>
              <div className="space-y-1">
                {executed.map((r) => (
                  <div key={r.id} className="flex items-start gap-2 rounded-lg px-1 py-1">
                    <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-violet-300" />
                    <span className="min-w-0 flex-1 text-xs text-muted">{r.summary ?? 'Executed a plan'}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
