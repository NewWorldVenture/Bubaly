'use client';

// The Autopilot panel — the family's control surface for the autonomous
// execution loop. Shows the trust dial (Auto-pilot / Ask first / Off), the
// queue of runs waiting for approval (one-tap Approve / Dismiss), and the feed
// of what Bubaly executed on its own. Reads the same trust_policies /
// family_automation_runs rows the server loop writes; all writes go through
// the manager-gated server actions.
//
// THE HANDLED NUMBER IS NOT THIS FILE'S TO INVENT. The header used to count
// runs with `trigger_type = 'plan_accepted'` and the legacy `status =
// 'executed'`, which is a third definition of "handled" that disagreed with the
// brief and with time-saved. It now counts exactly what
// `lib/metric/time-saved.ts` says counts — `HANDLED_RUN_STATES`, any trigger —
// so the same week reads the same number wherever the family looks.
//
// And a read that fails says so. The panel used to swallow every error and
// render an empty feed, which is the same lie as a zero: "Bubaly did nothing"
// when the truth is "we could not ask".
import { useCallback, useEffect, useState, useTransition } from 'react';
import { AlertTriangle, Bot, Check, ChevronDown, Loader2, ShieldQuestion, Sparkles, X, Zap } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { createClient } from '@/lib/supabase/client';
import { isManager } from '@/lib/constants/roles';
import { AUTOPILOT_POLICY_NAME, dialLevel, type AutopilotLevel } from '@/lib/autonomy/loop';
import { countOrNull, type MetricCount } from '@/lib/metric/count';
import { HANDLED_RUN_STATES } from '@/lib/metric/time-saved';
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

const WEEK_MS = 7 * 86_400_000;

const LEVELS: { key: AutopilotLevel; label: string; labelKey: string; hint: string; hintKey: string; icon: typeof Zap }[] = [
  { key: 'auto', label: 'Auto-pilot', labelKey: 'autopilotPanel.autoPilot', hint: 'Accepted plans execute on their own', hintKey: 'autopilotPanel.acceptedPlansExecuteOnTheirOwn', icon: Zap },
  { key: 'ask', label: 'Ask first', labelKey: 'autopilotPanel.askFirst', hint: 'Bubaly queues it for one-tap approval', hintKey: 'autopilotPanel.bubalyQueuesItForOneTapApproval', icon: ShieldQuestion },
  { key: 'off', label: 'Off', labelKey: 'autopilotPanel.off', hint: 'Manual buttons only', hintKey: 'autopilotPanel.manualButtonsOnly', icon: X },
];

export function AutopilotPanel({ className }: { className?: string }) {
  const t = useTranslations();
  const { familyId, role } = useApp();
  const { success, error: toastError } = useToast();
  const manager = isManager(role);
  const [level, setLevel] = useState<AutopilotLevel>('ask');
  const [runs, setRuns] = useState<Run[]>([]);
  const [handled, setHandled] = useState<MetricCount>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoaded(false);
    const supabase = createClient();
    const sinceIso = new Date(Date.now() - WEEK_MS).toISOString();
    try {
      const [policy, runRows, handledCount] = await Promise.all([
        supabase.from('trust_policies').select('effect')
          .eq('family_id', familyId).eq('name', AUTOPILOT_POLICY_NAME).maybeSingle(),
        supabase.from('family_automation_runs')
          .select('id, status, trigger_type, summary, created_at, metadata')
          .eq('family_id', familyId).eq('trigger_type', 'plan_accepted')
          .order('created_at', { ascending: false }).limit(30),
        // The ONE handled-this-week definition, counted in PostgreSQL.
        countOrNull(
          supabase.from('family_automation_runs').select('id', { count: 'exact', head: true })
            .eq('family_id', familyId).in('state', HANDLED_RUN_STATES).gte('created_at', sinceIso),
          'autopilot handled runs',
        ),
      ]);
      // A failed queue read must not render as an empty queue: "nothing is
      // waiting for you" is a claim, and we cannot make it.
      if (runRows.error) {
        console.error('[autopilot-panel] run feed read failed', runRows.error);
        setReadFailed(true);
      } else {
        setReadFailed(false);
        setRuns((runRows.data ?? []) as Run[]);
      }
      setLevel(dialLevel(policy.data?.effect));
      setHandled(handledCount);
    } catch (error) {
      console.error('[autopilot-panel] autopilot read failed', error);
      setReadFailed(true);
      setHandled(null);
    }
    setLoaded(true);
  }, [familyId]);

  useEffect(() => { void load(); }, [load]);

  const queued = runs.filter((r) => r.status === 'pending');
  const executed = runs.filter((r) => r.status === 'executed').slice(0, 5);

  const changeLevel = (next: AutopilotLevel) => {
    if (!manager || next === level) return;
    const prev = level;
    setLevel(next);
    startTransition(async () => {
      const res = await setConciergeAutopilotAction(next);
      if (!res.ok) { setLevel(prev); toastError(res.error); }
      else success(next === 'auto' ? t('autopilotPanel.autoPilotOnAcceptedPlansExecuteThemselves')
        : next === 'ask' ? t('autopilotPanel.bubalyWillAskBeforeExecuting')
        : t('autopilotPanel.autopilotOff'));
    });
  };

  const approve = (runId: string) => {
    setBusyId(runId);
    startTransition(async () => {
      const res = await executeQueuedRunAction(runId);
      if (!res.ok) toastError(res.error);
      else success(res.summary ?? t('autopilotPanel.executed'));
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
              {t(LEVELS.find((l) => l.key === level)?.labelKey ?? 'autopilotPanel.askFirst')}
            </span>
            {!readFailed && queued.length > 0 && (
              <span className="rounded-full bg-amber-500/20 px-2 py-0.5 text-[10px] font-bold text-amber-300">
                {t('autopilotPanel.nWaiting', { count: queued.length })}
              </span>
            )}
          </span>
          <span className="block text-xs text-muted">
            {handled === null
              ? t('autopilotPanel.couldNotReadWhatBubalyHandled')
              : handled > 0
                ? t('autopilotPanel.nThingsHandledForYouThisWeek', { count: handled })
                : t('autopilotPanel.acceptedPlansCanLandOnTheCalendar')}
          </span>
        </span>
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted transition-transform', open && 'rotate-180')} />
      </button>

      {open && (
        <div className="mt-4 space-y-4">
          {readFailed && (
            <div role="alert" className="flex items-start gap-2 rounded-xl border border-danger/30 bg-danger/5 px-3 py-2 text-xs">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" />
              <span className="min-w-0 flex-1 text-danger">{t('autopilotPanel.couldNotReadTheAutopilotQueue')}</span>
              <button type="button" onClick={() => void load()} className="font-semibold text-danger underline">
                {t('autopilotPanel.tryAgain')}
              </button>
            </div>
          )}

          {/* The dial */}
          <div>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted">
              {t('autopilot.whenYouAcceptAPlan')}{manager ? '' : ` ${t('autopilotPanel.parentsGuardiansCanChangeThis')}`}
            </p>
            <div className="grid grid-cols-3 gap-1.5">
              {LEVELS.map((l) => (
                <button
                  key={l.key}
                  type="button"
                  onClick={() => changeLevel(l.key)}
                  disabled={!manager || pending}
                  title={t(l.hintKey)}
                  className={cn(
                    'flex flex-col items-center gap-1 rounded-xl border px-2 py-2 text-[11px] font-bold transition disabled:cursor-not-allowed',
                    level === l.key
                      ? 'border-violet-400/60 bg-violet-500/15 text-violet-200'
                      : 'border-border text-muted hover:bg-elevated disabled:opacity-50',
                  )}
                >
                  <l.icon className="h-4 w-4" /> {t(l.labelKey)}
                </button>
              ))}
            </div>
          </div>

          {/* Waiting for approval */}
          {!readFailed && queued.length > 0 && (
            <div>
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300">{t('autopilot.waitingForYourOk')}</p>
              <div className="space-y-1.5">
                {queued.map((r) => (
                  <div key={r.id} className="flex items-center gap-2 rounded-xl border border-amber-400/25 bg-amber-500/[0.06] px-3 py-2">
                    <span className="min-w-0 flex-1 text-xs">
                      {(r.summary ?? t('autopilotPanel.queuedPlan')).replace(/^Waiting for approval: /, '')}
                    </span>
                    {manager && (
                      <>
                        <button
                          type="button" onClick={() => approve(r.id)} disabled={pending}
                          className="inline-flex h-7 items-center gap-1 rounded-lg bg-emerald-500/15 px-2.5 text-[11px] font-bold text-emerald-300 transition hover:bg-emerald-500/25 disabled:opacity-50"
                        >
                          {busyId === r.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />} {t('autopilotPanel.doIt')}
                        </button>
                        <button
                          type="button" onClick={() => dismiss(r.id)} disabled={pending}
                          aria-label={t('autopilotPanel.dismiss')} title={t('autopilotPanel.dismiss')}
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
          {!readFailed && executed.length > 0 && (
            <div>
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted">{t('autopilot.doneForYou')}</p>
              <div className="space-y-1">
                {executed.map((r) => (
                  <div key={r.id} className="flex items-start gap-2 rounded-lg px-1 py-1">
                    <Sparkles className="mt-0.5 h-3.5 w-3.5 shrink-0 text-violet-300" />
                    <span className="min-w-0 flex-1 text-xs text-muted">{r.summary ?? t('autopilotPanel.executedAPlan')}</span>
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
